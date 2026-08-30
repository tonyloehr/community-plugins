"""Reviewed desktop operations for qualified main-thread Fusion providers.

This module must be retained in ``sys.modules`` for the lifetime of a Fusion
session and invoked on Fusion's main Python thread, outside command callbacks.
It does not create a server, execute caller code, install an add-in, perform UI
text commands, or change a design to direct mode. Local handles and futures do
not survive a Fusion restart. The control service owns policy, approval, input
path allowlists and durable receipts; this module independently enforces target,
type, freshness, command, units and posting invariants at the API boundary.

Public member references are at
https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/<member>.htm.
The SOURCE_MEMBERS table is an implementation mapping, not a live qualification.
Offline tests use small API doubles. A licensed Fusion installation is required
to qualify kernel geometry, native script threading and machine-specific output.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import math
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import re
import stat
import threading
import uuid


_SESSION = "fusion_session_" + uuid.uuid4().hex
_API = None  # Lazily imported; injectable by offline contract tests.
_DOCUMENTS = {}
_ENTITIES = {}
_JOBS = {}
_MACHINE_OBSERVATIONS = {}
_HANDLERS = {}
_MAX_SCAN = 12000
_MAX_RESULT = 500
_MAX_HANDLES = 50000
_MAX_JOBS = 128
_MAX_FILE_BYTES = 1024 * 1024 * 1024
_MAX_REQUEST_BYTES = 2 * 1024 * 1024
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_IDLE_COMMANDS = ("", "SelectCommand")
_FRESHNESS_SCOPE = {
    "basis": "Bounded API observation, not a vendor revision lock or solver verification",
    "engineering_materials": "Material.materialProperties IDs, types, units and complete supported scalar/multiple values; reread on every observation",
    "material_hash_schema": "fusion_engineering_material_v1",
    "excluded": ["Material.appearance and appearance overrides", "texture/image file contents", "unexposed Autodesk internal state"],
    "visual_evidence": "The state token does not attest pixel-identical appearance or texture freshness; captures/renders require visual review",
}


class FusionError(Exception):
    def __init__(self, code, message, details=None, outcome="none"):
        super().__init__(message)
        self.code = code
        self.details = details
        self.outcome = outcome


def _fail(code, message, details=None, outcome="none"):
    raise FusionError(code, message, details, outcome)


def _text(value, label, max_length=1024, allow_empty=False):
    if not isinstance(value, str) or len(value) > max_length:
        _fail("INVALID_ARGUMENT", label + " must be a bounded string")
    if "\x00" in value or (not allow_empty and not value.strip()):
        _fail("INVALID_ARGUMENT", label + " must not be empty or contain NUL")
    return value


def _integer(value, label, minimum=0, maximum=_MAX_RESULT):
    if type(value) is not int or value < minimum or value > maximum:
        _fail("INVALID_ARGUMENT", "%s must be an integer in [%s, %s]" % (label, minimum, maximum))
    return value


def _boolean(value, label):
    if type(value) is not bool:
        _fail("INVALID_ARGUMENT", label + " must be boolean")
    return value


def _number(value, label):
    if type(value) not in (float, int) or not math.isfinite(value):
        _fail("INVALID_ARGUMENT", label + " must be a finite number")
    return float(value)


def _enum(value, choices, label):
    if not isinstance(value, str) or value not in choices:
        _fail("INVALID_ARGUMENT", label + " is not a supported value", {"allowed": list(choices)})
    return value


def _array(value, label, minimum=1, maximum=_MAX_RESULT):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail("INVALID_ARGUMENT", label + " must be a bounded array", {"minimum": minimum, "maximum": maximum})
    return value


def _fields(value, required=(), optional=(), label="args"):
    if not isinstance(value, dict):
        _fail("INVALID_ARGUMENT", label + " must be an object")
    extra = set(value) - set(required) - set(optional)
    missing = set(required) - set(value)
    if extra or missing:
        _fail("INVALID_ARGUMENT", label + " fields do not match the operation contract",
              {"unknown": sorted(extra), "missing": sorted(missing)})
    return value


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()


def _optional(obj, name, default=None):
    """Read a fixed, reviewed property. Never called with caller-selected names."""
    try:
        return getattr(obj, name)
    except (AttributeError, RuntimeError):
        return default


def _valid(obj):
    return obj is not None and _optional(obj, "isValid", True) is not False


def _same(left, right):
    # Autodesk directs callers to resolve tokens and compare the objects. Token
    # strings can change for the same entity and must not be used as identity.
    return left is right or (left is not None and right is not None and left == right)


def _type(obj):
    return _optional(obj, "objectType", "")


def _is(obj, *types):
    return _type(obj) in types


def _items(collection, maximum=_MAX_SCAN):
    if collection is None:
        return []
    if isinstance(collection, (list, tuple)):
        if len(collection) > maximum:
            _fail("LIMIT_EXCEEDED", "Collection exceeds the bounded traversal limit", {"maximum": maximum})
        return list(collection)
    count = collection.count
    if count > maximum:
        _fail("LIMIT_EXCEEDED", "Collection exceeds the bounded traversal limit", {"count": count, "maximum": maximum})
    return [collection.item(i) for i in range(count)]


class _Budget:
    def __init__(self, maximum=_MAX_SCAN):
        self.remaining = maximum

    def items(self, collection):
        result = _items(collection, self.remaining)
        self.remaining -= len(result)
        return result


def _api():
    global _API
    if _API is None:
        try:
            importlib.import_module("adsk.core")
            importlib.import_module("adsk.fusion")
            _API = importlib.import_module("adsk")
        except ImportError:
            _fail("FUSION_UNAVAILABLE", "Autodesk Fusion's Python API is unavailable; run through a qualified live Fusion execution provider")
    return _API


def _namespace(name):
    api = _api()
    if _optional(api, name) is None:
        try:
            importlib.import_module("adsk." + name)
        except ImportError:
            _fail("UNSUPPORTED", "This Fusion installation does not expose the required " + name + " product API")
    result = _optional(api, name)
    if result is None:
        _fail("UNSUPPORTED", "Required Autodesk product namespace is unavailable")
    return result


def _object_collection(values):
    result = _api().core.ObjectCollection.create()
    for value in values:
        if result.add(value) is False:
            _fail("API_REJECTED", "Autodesk rejected an input collection member")
    return result


def _document_id(doc):
    for handle, current in _DOCUMENTS.items():
        if _valid(current) and _same(current, doc):
            return handle
    if len(_DOCUMENTS) >= 256:
        # Closed document IDs remain invalid; they are never rebound by name or
        # creationId. Removing them does not make stale IDs target a new tab.
        for handle in list(_DOCUMENTS):
            if not _valid(_DOCUMENTS[handle]):
                del _DOCUMENTS[handle]
        if len(_DOCUMENTS) >= 256:
            _fail("LIMIT_EXCEEDED", "Too many tracked documents in this session")
    handle = "doc_" + uuid.uuid4().hex
    _DOCUMENTS[handle] = doc
    return handle


def _get_document(app, handle):
    _text(handle, "document_id", 128)
    candidate = _DOCUMENTS.get(handle)
    if not _valid(candidate) or not any(_same(candidate, d) for d in _items(app.documents, 256)):
        _fail("DOCUMENT_NOT_FOUND", "Document handle is closed, unknown, or belongs to another Fusion session")
    return candidate


def _product(doc, product_type, required=True):
    product = doc.products.itemByProductType(product_type)
    if _valid(product):
        if product_type == "DesignProductType":
            product = _api().fusion.Design.cast(product)
        elif product_type == "CAMProductType":
            product = _namespace("cam").CAM.cast(product)
    if not _valid(product):
        if required:
            _fail("WRONG_PRODUCT", "The requested document does not contain " + product_type)
        return None
    return product


def _configuration(design):
    if design is None:
        return None
    configured = _optional(design, "isConfiguredDesign")
    instance = _optional(design, "isConfiguration")
    table = _optional(design, "configurationTopTable") if configured else None
    active_row = _optional(table, "activeRow") if table is not None else None
    return {"is_configured_design": configured, "is_configuration": instance,
            "row_id": _optional(design, "configurationRowId") if instance else _optional(active_row, "id"),
            "table_id": _optional(table, "id")}


def _config_key(design):
    return _hash(_configuration(design))


def _entity_revision(obj):
    revision = _optional(obj, "revisionId")
    if revision is not None:
        return str(revision)
    sketch = _optional(obj, "parentSketch")
    if sketch is not None:
        return _optional(sketch, "revisionId")
    body = _optional(obj, "body")
    if body is not None:
        return _optional(body, "revisionId")
    return None


def _register(ctx, obj, kind=None, refresh=True):
    if not _valid(obj):
        _fail("ENTITY_NOT_FOUND", "Cannot register an invalid Autodesk object")
    configuration = _config_key(ctx.design)
    obj_type = _type(obj)
    for handle, entry in _ENTITIES.items():
        if entry["document_id"] == ctx.document_id and entry["configuration"] == configuration and _same(entry["object"], obj):
            # A new inspection refreshes the observation attached to a handle.
            if refresh:
                entry["revision"] = _entity_revision(obj)
            return handle
    if len(_ENTITIES) >= _MAX_HANDLES:
        _fail("LIMIT_EXCEEDED", "Entity handle registry is full; reconnect after finishing outstanding work")
    handle = "entity_" + uuid.uuid4().hex
    _ENTITIES[handle] = {"document_id": ctx.document_id, "configuration": configuration,
                         "object": obj, "object_type": obj_type, "kind": kind,
                         "token": _optional(obj, "entityToken"), "revision": _entity_revision(obj),
                         "assembly_context": _optional(obj, "assemblyContext")}
    return handle


def _resolve(ctx, handle, allowed=(), native_only=False):
    _text(handle, "entity_id", 128)
    entry = _ENTITIES.get(handle)
    if entry is None or entry["document_id"] != ctx.document_id:
        _fail("ENTITY_NOT_FOUND", "Entity handle is unknown or belongs to another document")
    if entry["configuration"] != _config_key(ctx.design):
        _fail("STALE_ENTITY", "The configuration changed; inspect and select the entity again")
    obj = entry["object"]
    if entry["token"] is not None:
        if ctx.design is None:
            _fail("WRONG_PRODUCT", "A Design is required to resolve this entity token")
        matches = ctx.design.findEntityByToken(entry["token"])
        matches = _items(matches)
        if len(matches) != 1:
            _fail("AMBIGUOUS_ENTITY" if matches else "ENTITY_NOT_FOUND",
                  "Entity token must resolve to exactly one entity; reselect after topology changes",
                  {"match_count": len(matches)})
        obj = matches[0]
    if not _valid(obj) or _type(obj) != entry["object_type"]:
        _fail("STALE_ENTITY", "The entity is invalid or its type changed")
    if not _same(_optional(obj, "assemblyContext"), entry["assembly_context"]):
        _fail("STALE_ENTITY", "The entity occurrence context changed")
    if entry["revision"] is not None and _entity_revision(obj) != entry["revision"]:
        _fail("STALE_ENTITY", "The selected geometry changed; inspect and select it again")
    if allowed and _type(obj) not in allowed:
        _fail("WRONG_ENTITY_TYPE", "Entity is not valid for this operation", {"actual": _type(obj), "allowed": list(allowed)})
    if native_only and _optional(obj, "assemblyContext") is not None:
        _fail("UNSUPPORTED_CONTEXT", "This mutation variant accepts native component geometry only; select from the component definition")
    entry["object"] = obj
    return obj


def _resolve_many(ctx, values, allowed=(), native_only=False, maximum=_MAX_RESULT):
    handles = _array(values, "entity_ids", maximum=maximum)
    if len(set(_text(h, "entity_id", 128) for h in handles)) != len(handles):
        _fail("INVALID_ARGUMENT", "Entity handles must be unique")
    objects = [_resolve(ctx, h, allowed, native_only) for h in handles]
    if any(_same(obj, prior) for i, obj in enumerate(objects) for prior in objects[:i]):
        _fail("AMBIGUOUS_ENTITY", "Different handles resolved to the same entity")
    return objects


def _data_file_identity(data_file):
    if data_file is None:
        return None
    return {"lineage_id": data_file.id, "version_id": data_file.versionId,
            "version_number": data_file.versionNumber,
            "project_id": _optional(_optional(data_file, "parentProject"), "id"),
            "folder_id": _optional(_optional(data_file, "parentFolder"), "id"),
            "is_complete": _optional(data_file, "isComplete")}


def _cloud_identity(doc):
    return _data_file_identity(doc.dataFile)


def _reference_identity(occurrence):
    if not occurrence.isReferencedComponent:
        return None
    reference = occurrence.documentReference
    result = _data_file_identity(reference.dataFile)
    if result is not None:
        result["reference_version"] = reference.version
        result["out_of_date"] = reference.isOutOfDate
    return result


def _document_summary(app, doc):
    return {"document_id": _document_id(doc), "session_id": _SESSION, "name": doc.name,
            "creation_id": doc.creationId, "is_saved": doc.isSaved,
            "is_modified": doc.isModified, "is_active": _same(app.activeDocument, doc),
            "is_up_to_date": _optional(doc, "isUpToDate"), "cloud": _cloud_identity(doc),
            "products": [_optional(p, "productType", _type(p)) for p in _items(doc.products, 16)]}


def _session_state(app):
    return _hash({"session": _SESSION, "documents": [_document_summary(app, d) for d in _items(app.documents, 256)]})


def _parameter_observation(p):
    return {"name": p.name, "expression": p.expression, "unit": p.unit,
            "value_internal": p.value, "type": _type(p)}


def _material_property_observation(prop, budget):
    """Read only released typed material values; never dereference a filename."""
    result = {"id": _text(prop.id, "material property ID", 4096), "type": _type(prop)}
    if not _valid(prop):
        _fail("MATERIAL_PROPERTY_INVALID", "Material property is invalid")
    core = _api().core
    if _is(prop, "adsk::core::FloatProperty"):
        value = core.FloatProperty.cast(prop)
        if value.hasConnectedTexture:
            # Autodesk documents this as false for non-appearance properties.
            # An unexpected numeric material texture cannot be treated as a
            # complete physical value merely because the type is a float.
            result["unqualified"] = "numeric_material_texture_not_fingerprinted"
            return result
        multiple = _boolean(value.hasMultipleValues, "material property hasMultipleValues")
        result.update({"units": _text(value.units, "material property units", 512, allow_empty=True), "multiple": multiple})
        result["values"] = [_number(v, "material property value") for v in budget.items(value.values)] if multiple else [_number(value.value, "material property value")]
    elif _is(prop, "adsk::core::IntegerProperty"):
        value = core.IntegerProperty.cast(prop)
        multiple = _boolean(value.hasMultipleValues, "material property hasMultipleValues")
        result["multiple"] = multiple
        result["values"] = [_integer(v, "material property value", -2147483648, 2147483647) for v in budget.items(value.values)] if multiple else [_integer(value.value, "material property value", -2147483648, 2147483647)]
    elif _is(prop, "adsk::core::BooleanProperty"):
        result["value"] = _boolean(core.BooleanProperty.cast(prop).value, "material property value")
    elif _is(prop, "adsk::core::StringProperty"):
        result["value"] = _text(core.StringProperty.cast(prop).value, "material property value", 16384, allow_empty=True)
    elif _is(prop, "adsk::core::ChoiceProperty"):
        # The stored choice value is stable; Property.name and choice display
        # labels are localized and are not used as the property's identity.
        result["value"] = _text(core.ChoiceProperty.cast(prop).value, "material property choice", 4096, allow_empty=True)
    elif _is(prop, "adsk::core::ColorProperty"):
        value = core.ColorProperty.cast(prop)
        if value.hasConnectedTexture:
            result["excluded"] = "visual_texture"
            return result
        multiple = _boolean(value.hasMultipleValues, "material property hasMultipleValues")
        colors = budget.items(value.values) if multiple else [value.value]
        result["multiple"] = multiple
        result["rgba_bytes"] = [[_integer(channel, "material color channel", 0, 255) for channel in
                                 (color.red, color.green, color.blue, color.opacity)] for color in colors]
    elif _is(prop, "adsk::core::AppearanceTextureProperty"):
        # This exact released type is visual. Reading .value would traverse the
        # appearance texture graph and is intentionally outside this evidence.
        result["excluded"] = "visual_texture"
    elif _is(prop, "adsk::core::FilenameProperty"):
        value = core.FilenameProperty.cast(prop)
        multiple = _boolean(value.hasMultipleValues, "material property hasMultipleValues")
        filenames = budget.items(value.values) if multiple else [value.value]
        filenames = [_text(name, "material filename reference", 4096, allow_empty=True) for name in filenames]
        result["reference_sha256"] = _hash(filenames)
        if any(filenames):
            # This generic type does not establish that a dependency is merely
            # visual. Do not read arbitrary material-provided paths or claim
            # their bytes are covered by the engineering fingerprint.
            result["unqualified"] = "external_material_file_not_fingerprinted"
    else:
        result["unqualified"] = "unsupported_engineering_property_type"
    return result


def _material_observation(material, budget, gaps, cache):
    if material is None:
        return None
    # Cache only within this individual snapshot, by actual API object equality.
    # Different library/document definitions can have the same material ID.
    for current, observation in cache:
        if _same(current, material):
            gaps.extend(observation["freshness_gaps"])
            return observation
    observation = {"material_id": _optional(material, "id"), "name": _optional(material, "name"),
                   "description": _optional(material, "description"), "qualified": True,
                   "property_count": 0, "excluded_visual_property_ids": [], "freshness_gaps": [],
                   "evidence_scope": "Released engineering material property values; no appearance or texture contents"}
    records, issues = [], observation["freshness_gaps"]
    try:
        if not _valid(material):
            _fail("MATERIAL_INVALID", "Assigned material is invalid")
        properties = budget.items(material.materialProperties)
        observation["property_count"] = len(properties)
        if not properties:
            issues.append("engineering_material:properties_unavailable_or_empty")
        seen = set()
        for prop in properties:
            try:
                item = _material_property_observation(prop, budget)
                if item["id"] in seen:
                    issues.append("engineering_material:duplicate_property_id")
                seen.add(item["id"])
                if item.get("excluded"):
                    observation["excluded_visual_property_ids"].append(item["id"])
                if item.get("unqualified"):
                    issues.append("engineering_material:" + item["unqualified"] + ":" + item["type"])
            except (FusionError, AttributeError, RuntimeError, TypeError, ValueError, OverflowError) as error:
                item = {"id": _optional(prop, "id"), "type": _type(prop), "unqualified": type(error).__name__}
                issues.append("engineering_material:property_value_unavailable:" + _type(prop))
            records.append(item)
        records.sort(key=lambda item: (str(item.get("id")), item["type"]))
        payload = {"schema": "fusion_engineering_material_v1", "properties": records}
        if len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 1024 * 1024:
            _fail("LIMIT_EXCEEDED", "Material definition exceeds the bounded engineering fingerprint size")
        observation["engineering_sha256"] = _hash(payload)
    except (FusionError, AttributeError, RuntimeError, TypeError, ValueError, OverflowError) as error:
        observation["engineering_sha256"] = None
        issues.append("engineering_material:definition_unavailable:" + type(error).__name__)
    observation["freshness_gaps"] = sorted(set(issues))
    observation["qualified"] = not observation["freshness_gaps"]
    gaps.extend(observation["freshness_gaps"])
    if len(cache) < 1024:
        cache.append((material, observation))
    else:
        gaps.append("engineering_material:distinct_definition_limit")
    return observation


def _selection_observation(ctx, obj):
    return {"entity_id": _register(ctx, obj, refresh=False), "type": _type(obj), "revision": _entity_revision(obj),
            "context": _optional(_optional(obj, "assemblyContext"), "fullPathName")}


def _cam_parameter_observation(p, ctx=None, budget=None, gaps=None):
    value = p.value
    result = {"name": p.name, "expression": p.expression, "type": _type(value),
              "editable": p.isEditable, "enabled": p.isEnabled, "deprecated": p.isDeprecated,
              "error": p.error, "warning": p.warning}
    if _is(value, "adsk::cam::StringParameterValue", "adsk::cam::ChoiceParameterValue",
           "adsk::cam::IntegerParameterValue", "adsk::cam::FloatParameterValue", "adsk::cam::BooleanParameterValue"):
        result["value"] = value.value
    elif ctx is not None:
        budget = budget or _Budget()
        if _is(value, "adsk::cam::CadObjectParameterValue"):
            result["selection"] = [_selection_observation(ctx, obj) for obj in budget.items(value.value)]
        elif _is(value, "adsk::cam::CadContours2dParameterValue"):
            result["curve_selections"] = []
            for selection in budget.items(value.getCurveSelections()):
                if not _is(selection, "adsk::cam::ChainSelection"):
                    if gaps is not None:
                        gaps.append("unqualified_cam_curve_selection:" + _type(selection))
                    result["curve_selections"].append({"type": _type(selection), "qualified": False})
                    continue
                result["curve_selections"].append({"type": _type(selection),
                    "input": [_selection_observation(ctx, obj) for obj in budget.items(selection.inputGeometry)],
                    "resolved": [_selection_observation(ctx, obj) for obj in budget.items(selection.value)],
                    "reversed": selection.isReverted, "open": selection.isOpen})
        elif p.isEnabled and p.isEditable and not p.isDeprecated and gaps is not None:
            gaps.append("unqualified_cam_parameter_type:" + _type(value))
    return result


def _machine_observation(ctx, machine):
    if machine is None:
        return None
    key = (ctx.document_id, machine.id)
    observed = _MACHINE_OBSERVATIONS.get(key)
    if observed is None or not machine.equivalentTo(observed["copy"]):
        if len(_MACHINE_OBSERVATIONS) >= 1024:
            _fail("LIMIT_EXCEEDED", "Too many machine definitions tracked in this session")
        # Setup.machine returns a transient copy. Holding it allows the released
        # equivalentTo API to detect kinematic/definition edits without inventing
        # a Machine.toJson method or treating an ID as a full definition hash.
        observed = {"id": "machine_observation_" + uuid.uuid4().hex, "copy": machine}
        _MACHINE_OBSERVATIONS[key] = observed
    return {"machine_id": machine.id, "definition_observation": observed["id"]}


def _cam_operation_state(operation):
    # OperationBase also represents folders/setups and generated additive data.
    # Only concrete cutting Operation objects may pass the posting guard.
    result = {"vendor_id": operation.operationId, "name": operation.name, "type": _type(operation),
              "suppressed": operation.isSuppressed, "has_error": operation.hasError,
              "has_warning": operation.hasWarning, "error": operation.error, "warning": operation.warning}
    if _is(operation, "adsk::cam::Operation"):
        result.update({"strategy": operation.strategy, "has_toolpath": operation.hasToolpath,
                       "toolpath_valid": operation.isToolpathValid, "generating": operation.isGenerating,
                       "operation_state": int(operation.operationState)})
        tool = operation.tool
        result["tool_sha256"] = _hash(json.loads(tool.toJson())) if tool is not None else None
    return result


def _state(ctx):
    """Bounded observation fingerprint, explicitly not a vendor lock or revision."""
    budget = _Budget()
    observation = {"document": _document_summary(ctx.app, ctx.doc), "configuration": _configuration(ctx.design)}
    gaps, material_cache = [], []
    viewport = _optional(ctx.app, "activeViewport")
    if viewport is not None and _same(viewport.parentDocument, ctx.doc):
        camera = viewport.camera
        observation["camera"] = {"eye_cm": _point_data(camera.eye), "target_cm": _point_data(camera.target),
                                 "up": _point_data(camera.upVector), "type": _optional(camera, "cameraType"),
                                 "view_extents": _optional(camera, "viewExtents"),
                                 "perspective_angle": _optional(camera, "perspectiveAngle")}
    if ctx.design is not None:
        design = ctx.design
        observation["design_type"] = int(design.designType)
        observation["default_length_units"] = design.unitsManager.defaultLengthUnits
        config = observation["configuration"]
        if config["is_configured_design"] is None or config["is_configuration"] is None:
            gaps.append("configuration_identity_unavailable")
        observation["parameters"] = [_parameter_observation(p) for p in budget.items(design.allParameters)]
        observation["components"] = []
        for comp in budget.items(design.allComponents):
            component = {"id": comp.id, "name": comp.name, "part_number": comp.partNumber, "description": comp.description,
                         "material": _material_observation(comp.material, budget, gaps, material_cache), "bodies": [], "sketches": []}
            for body in budget.items(comp.bRepBodies):
                revision = _optional(body, "revisionId")
                if revision is None:
                    gaps.append("body_revision_unavailable")
                component["bodies"].append({"revision": revision, "name": body.name,
                                             "solid": body.isSolid,
                                             "material": _material_observation(body.material, budget, gaps, material_cache)})
                if body.isSolid and body.material is None:
                    gaps.append("engineering_material:solid_body_material_unavailable")
            for sketch in budget.items(comp.sketches):
                revision = _optional(sketch, "revisionId")
                if revision is None:
                    gaps.append("sketch_revision_unavailable")
                component["sketches"].append({"revision": revision, "name": sketch.name,
                                               "curve_count": sketch.sketchCurves.count,
                                               "profile_count": sketch.profiles.count})
            observation["components"].append(component)
        observation["occurrences"] = [{"component": occ.component.id, "path": occ.fullPathName,
                                        "transform_cm": list(occ.transform2.asArray()),
                                        "grounded": occ.isGrounded, "referenced": occ.isReferencedComponent,
                                        "reference": _reference_identity(occ),
                                        "configuration_row": _optional(_optional(occ, "configurationRow"), "id")}
                                       for occ in budget.items(design.rootComponent.allOccurrences)]
        timeline = design.timeline
        observation["timeline"] = {"marker": timeline.markerPosition, "count": timeline.count,
                                   "health": [{"name": _optional(t.entity, "name"),
                                               "health": _optional(t.entity, "healthState"),
                                               "message": _optional(t.entity, "errorOrWarningMessage")}
                                              for t in budget.items(timeline)]} if timeline is not None else None
    cam = _product(ctx.doc, "CAMProductType", False)
    if cam is not None:
        observation["cam"] = []
        for setup in budget.items(cam.setups):
            result = _cam_operation_state(setup)
            result["parameters"] = [_cam_parameter_observation(p, ctx, budget, gaps) for p in budget.items(setup.parameters)]
            result["wcs_cm"] = list(setup.workCoordinateSystem.asArray())
            result["machine"] = _machine_observation(ctx, setup.machine)
            result["models"] = [_selection_observation(ctx, o) for o in budget.items(setup.models)]
            result["fixtures"] = [_selection_observation(ctx, o) for o in budget.items(setup.fixtures)]
            result["operations"] = []
            for op in budget.items(setup.allOperations):
                item = _cam_operation_state(op)
                item["parameters"] = [_cam_parameter_observation(p, ctx, budget, gaps) for p in budget.items(op.parameters)]
                result["operations"].append(item)
            observation["cam"].append(result)
    return _hash(observation), sorted(set(gaps))


class _Context:
    def __init__(self, request, app):
        self.request = request
        self.app = app
        self.args = request["args"]
        self.document_id = request.get("document_id")
        self.doc = _get_document(app, self.document_id) if self.document_id else None
        self.design = _product(self.doc, "DesignProductType", False) if self.doc else None
        self.effects = []
        self.attempting = False

    def require_design(self, editable=False):
        if self.design is None:
            _fail("WRONG_PRODUCT", "This operation requires a Design product in the explicit document")
        if editable:
            if _optional(self.design, "isConfiguration") is None:
                _fail("FRESHNESS_UNAVAILABLE", "This build cannot establish configuration edit authority")
            if self.design.isConfiguration:
                _fail("READ_ONLY_CONFIGURATION", "This is a generated read-only configuration; open the authorized configured master and row before editing")
        return self.design

    def require_cam(self):
        if self.doc is None:
            _fail("DOCUMENT_REQUIRED", "CAM operations require an explicit document handle")
        _namespace("cam")
        return _product(self.doc, "CAMProductType")

    def before(self, editable=True, active=True):
        if threading.current_thread() is not threading.main_thread():
            _fail("WRONG_THREAD", "Fusion API calls must execute on the main thread")
        if self.app.userInterface.activeCommand not in _IDLE_COMMANDS:
            _fail("FUSION_BUSY", "Finish the active Fusion command before this operation")
        if _optional(self.app, "hasActiveJobs", False) and self.request["operation"] != "render.start":
            _fail("FUSION_BUSY", "Fusion has active background jobs; wait for their actual completion before executing another effect")
        if self.doc is None:
            expected = self.request.get("expected_state")
            if expected is not None and expected != _session_state(self.app):
                _fail("STALE_STATE", "The open-document session changed after planning")
            return
        _get_document(self.app, self.document_id)
        if active and not _same(self.app.activeDocument, self.doc):
            _fail("DOCUMENT_NOT_ACTIVE", "Activate the explicitly selected document with documents.activate first")
        if editable and self.design is not None:
            self.require_design(True)
        expected = self.request.get("expected_state")
        if not expected:
            _fail("EXPECTED_STATE_REQUIRED", "Inspect this document and pass its current state before executing an effect")
        state, gaps = _state(self)
        if gaps:
            _fail("FRESHNESS_UNAVAILABLE", "The API does not expose enough state for a guarded operation", {"gaps": gaps})
        if state != expected:
            _fail("STALE_STATE", "Document, configuration, model, or CAM state changed after planning", {"current_state": state})

    def effect(self, message):
        self.effects.append(message)
        self.attempting = False

    def call(self, function, *args):
        # A native exception can follow a side effect. Never call it an all-none
        # failure unless the documented API explicitly provides that guarantee.
        self.attempting = True
        result = function(*args)
        if result is None or result is False:
            _fail("API_REJECTED", "Autodesk rejected the operation; inspect the reported state before retrying", outcome="unknown")
        return result


def _operation(name, required=(), optional=(), document=True, read=False):
    def register(function):
        _HANDLERS[name] = (function, required, optional, document, read)
        return function
    return register


def dispatch(request: dict) -> dict:
    """Execute one fixed operation; return only JSON-compatible evidence."""
    ctx = None
    try:
        try:
            encoded_request = json.dumps(request, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError) as error:
            _fail("INVALID_ARGUMENT", "Request must contain only finite bounded JSON values", {"exception_type": type(error).__name__})
        if len(encoded_request) > _MAX_REQUEST_BYTES:
            _fail("LIMIT_EXCEEDED", "Desktop request exceeds the reviewed 2 MiB JSON envelope bound")
        _fields(request, ("operation", "args", "request_id"), ("document_id", "expected_state"), "request")
        operation = _text(request["operation"], "operation", 128)
        _text(request["request_id"], "request_id", 128)
        if "expected_state" in request:
            _text(request["expected_state"], "expected_state", 128)
        definition = _HANDLERS.get(operation)
        if definition is None:
            _fail("UNSUPPORTED_OPERATION", "No reviewed desktop handler exists for this operation", {"operation": operation})
        function, required, optional, document, read = definition
        _fields(request["args"], required, optional)
        if document and not request.get("document_id"):
            _fail("DOCUMENT_REQUIRED", "This operation requires an explicit opaque document_id from documents.list")
        if not document and request.get("document_id"):
            _fail("INVALID_ARGUMENT", "Session operations must not include a document_id")
        if threading.current_thread() is not threading.main_thread():
            _fail("WRONG_THREAD", "Fusion API calls must execute on the main thread")
        app = _api().core.Application.get()
        if app is None:
            _fail("FUSION_UNAVAILABLE", "No live Autodesk Fusion application is available")
        ctx = _Context(request, app)
        if read and "expected_state" in request:
            current_state = _state(ctx)[0] if ctx.doc is not None else _session_state(app)
            if request["expected_state"] != current_state:
                _fail("STALE_STATE", "The selected source changed between read pages or after inspection", {"current_state": current_state})
        data = function(ctx)
        result = {"ok": True, "data": data, "effects": ctx.effects}
        if ctx.doc is not None and _valid(ctx.doc) and operation != "documents.close":
            try:
                state, gaps = _state(ctx)
                result["state"] = state
                if isinstance(data, dict):
                    data["freshness_scope"] = _FRESHNESS_SCOPE
                if gaps and isinstance(data, dict):
                    data["freshness_gaps"] = gaps
            except (FusionError, RuntimeError, AttributeError) as error:
                if isinstance(data, dict):
                    data["freshness_unavailable"] = str(error)[:512]
        elif operation in ("documents.list", "documents.close"):
            result["state"] = _session_state(app)
        if len(json.dumps(result, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")) > _MAX_RESPONSE_BYTES:
            _fail("LIMIT_EXCEEDED", "Desktop result exceeds the reviewed 4 MiB JSON envelope bound; reduce page size or select fewer entities")
        return result
    except FusionError as error:
        outcome = error.outcome
        if ctx is not None:
            if ctx.effects:
                outcome = "partial"
            elif ctx.attempting and outcome == "none":
                outcome = "unknown"
        details = error.details
        if ctx is not None and (ctx.effects or ctx.attempting):
            details = {"cause": details, "effects": ctx.effects, "operation_attempted": ctx.attempting,
                       "recovery": "Inspect the exact document and artifacts; no automatic undo or retry was performed"}
        return {"ok": False, "error": {"code": error.code, "message": str(error), "details": details, "outcome": outcome}}
    except Exception as error:
        outcome = "partial" if ctx and ctx.effects else "unknown" if ctx and ctx.attempting else "none"
        return {"ok": False, "error": {"code": "API_ERROR", "message": str(error)[:1024],
                "details": {"exception_type": type(error).__name__, "effects": ctx.effects if ctx else [],
                            "live_validation": "required"}, "outcome": outcome}}


def _component(ctx, handle=None, editable=False):
    design = ctx.require_design(editable)
    comp = _resolve(ctx, handle, ("adsk::fusion::Component",), True) if handle else design.rootComponent
    # A linked component may have a Design other than the edit target. Do not
    # implicitly break its link or apply a native mutation to the source file.
    owner = _optional(comp, "parentDesign")
    if editable and owner is not None and not _same(owner, design):
        _fail("EXTERNAL_REFERENCE_READ_ONLY", "Open the referenced source document explicitly before editing it")
    if editable:
        for occ in _items(design.rootComponent.allOccurrences):
            if _same(occ.component, comp) and occ.isReferencedComponent:
                _fail("EXTERNAL_REFERENCE_READ_ONLY", "A referenced component cannot be edited through this assembly")
    return comp


def _owner_component(ctx, objects, editable=True):
    components = []
    for obj in objects:
        comp = _optional(obj, "parentComponent")
        if _is(obj, "adsk::fusion::Profile", "adsk::fusion::SketchLine", "adsk::fusion::SketchCircle", "adsk::fusion::SketchPoint"):
            comp = obj.parentSketch.parentComponent
        elif _is(obj, "adsk::fusion::BRepFace", "adsk::fusion::BRepEdge"):
            comp = obj.body.parentComponent
        if comp is None:
            _fail("UNSUPPORTED_CONTEXT", "The owning component cannot be established for this entity type")
        if not any(_same(comp, existing) for existing in components):
            components.append(comp)
    if len(components) != 1:
        _fail("UNSUPPORTED_CONTEXT", "This feature variant requires all native geometry in one component")
    return _component(ctx, _register(ctx, components[0], "component"), editable)


def _expression(ctx, value, unit, label="expression", positive=False):
    expression = _text(value, label, 512)
    units = ctx.require_design().unitsManager
    # Reject unqualified dimensional literals. Parameter names/formulas are
    # allowed and checked by Fusion's units parser, never Python evaluation.
    if unit and not re.search(r"[a-df-zA-DF-Z_µμ°]", expression):
        _fail("UNITS_REQUIRED", label + " must include units or reference a dimensioned parameter")
    if not units.isValidExpression(expression, unit):
        _fail("INVALID_EXPRESSION", label + " is not valid for the requested physical dimension", {"unit": unit})
    evaluated = units.evaluateExpression(expression, unit)
    if not math.isfinite(evaluated) or (positive and evaluated <= 0):
        _fail("INVALID_EXPRESSION", label + " must evaluate to a finite" + (" positive" if positive else "") + " value")
    return expression, evaluated


def _value_input(ctx, value, unit="cm", label="expression", positive=False):
    expression, _ = _expression(ctx, value, unit, label, positive)
    return _api().core.ValueInput.createByString(expression)


def _point(ctx, coordinates, dimensions=3):
    values = _array(coordinates, "point", dimensions, dimensions)
    xyz = [_expression(ctx, v, "cm", "coordinate")[1] for v in values]
    if dimensions == 2:
        xyz.append(0.0)
    return _api().core.Point3D.create(*xyz)


def _point_data(point):
    return [point.x, point.y, point.z]


def _geometry_frame(ctx, obj):
    """Do not turn a provider coordinate into a global assembly coordinate."""
    if _is(obj, "adsk::fusion::SketchLine", "adsk::fusion::SketchCircle", "adsk::fusion::SketchPoint", "adsk::fusion::Profile"):
        return {"kind": "sketch", "sketch_id": _register(ctx, obj.parentSketch, "sketch"), "qualified": True}
    occurrence = _optional(obj, "assemblyContext")
    comp = obj if _is(obj, "adsk::fusion::Component") else None
    if _is(obj, "adsk::fusion::BRepBody"):
        comp = obj.parentComponent
    elif _is(obj, "adsk::fusion::BRepFace", "adsk::fusion::BRepEdge"):
        comp = obj.body.parentComponent
    if occurrence is None and comp is not None:
        return {"kind": "component", "component_id": _register(ctx, comp, "component"), "qualified": True}
    return {"kind": "unqualified_provider_frame", "entity_id": _register(ctx, obj), "qualified": False,
            "assembly_context_id": _register(ctx, occurrence, "occurrence") if occurrence is not None else None,
            "reason": "This provider coordinate has not been normalized to a qualified component/root frame; do not use it for positional machining inputs"}


def _bbox_data(box, frame):
    return {"min": _point_data(box.minPoint), "max": _point_data(box.maxPoint), "unit": "cm", "frame": frame}


def _entity_summary(ctx, obj, kind=None):
    result = {"entity_id": _register(ctx, obj, kind), "kind": kind, "object_type": _type(obj),
              "name": _optional(obj, "name"), "revision": _entity_revision(obj)}
    occurrence = _optional(obj, "assemblyContext")
    result["entity_context"] = "occurrence_proxy" if occurrence is not None else "native"
    if _is(obj, "adsk::fusion::SketchLine", "adsk::fusion::SketchCircle", "adsk::fusion::SketchPoint", "adsk::fusion::Profile"):
        result["frame"] = "sketch"
        result["sketch_id"] = _register(ctx, obj.parentSketch, "sketch")
    if occurrence is not None:
        result["occurrence_id"] = _register(ctx, occurrence, "occurrence")
        result["occurrence_path"] = occurrence.fullPathName
    if _is(obj, "adsk::fusion::Occurrence"):
        result.update({"component_id": _register(ctx, obj.component, "component"),
                       "transform": {"frame": "parent", "matrix": list(obj.transform2.asArray()), "translation_unit": "cm", "layout": "row_major"},
                       "referenced": obj.isReferencedComponent, "grounded": obj.isGrounded,
                       "occurrence_path": obj.fullPathName})
    if _is(obj, "adsk::fusion::BRepBody"):
        result.update({"solid": obj.isSolid, "sheet_metal": _optional(obj, "isSheetMetal"),
                       "face_count": obj.faces.count, "edge_count": obj.edges.count,
                       "material_id": _optional(_optional(obj, "material"), "id")})
    if _is(obj, "adsk::fusion::Sketch"):
        result.update({"profile_count": obj.profiles.count, "curve_count": obj.sketchCurves.count,
                       "is_fully_constrained": _optional(obj, "isFullyConstrained"),
                       "component_id": _register(ctx, obj.parentComponent, "component")})
    if _is(obj, "adsk::fusion::SketchLine"):
        result.update({"start_point_id": _register(ctx, obj.startSketchPoint, "sketch_point"),
                       "end_point_id": _register(ctx, obj.endSketchPoint, "sketch_point")})
    box = _optional(obj, "boundingBox")
    if box is not None:
        frame = _geometry_frame(ctx, obj)
        result["frame"] = frame["kind"]
        result["bounding_box"] = _bbox_data(box, frame)
    health = _optional(obj, "healthState")
    if health is not None:
        result["health_state"] = int(health)
        result["health_message"] = _optional(obj, "errorOrWarningMessage", "")
    return result


def _path(value, extensions=(), existing=False, directory=False):
    raw = _text(value, "path", 4096)
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts or raw.startswith(("//", "\\\\")) or ":" in path.name:
        _fail("UNSAFE_PATH", "An explicit absolute local path without traversal, UNC or alternate streams is required")
    if extensions and path.suffix.lower() not in extensions:
        _fail("INVALID_ARGUMENT", "Path extension does not match the artifact format", {"allowed": list(extensions)})
    for parent in [*reversed(path.parents), path]:
        try:
            metadata = parent.lstat()
        except FileNotFoundError:
            if parent != path:
                _fail("UNSAFE_PATH", "The approved output parent directory must already exist")
            continue
        if stat.S_ISLNK(metadata.st_mode) or (_optional(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            _fail("UNSAFE_PATH", "Symbolic links and reparse points are not accepted in an artifact or profile path")
        if parent == path and not directory and stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
            _fail("UNSAFE_PATH", "Hardlinked input/output artifacts are not accepted")
    if directory:
        if not path.is_dir():
            _fail("UNSAFE_PATH", "The approved quarantine directory must already exist")
    elif existing:
        if not path.is_file() or path.stat().st_size > _MAX_FILE_BYTES:
            _fail("UNSAFE_PATH", "The approved profile/template must be a bounded regular file")
    elif path.exists():
        _fail("OUTPUT_EXISTS", "Artifact output already exists; choose a new staging path")
    if not existing:
        parent = path if directory else path.parent
        metadata = parent.stat()
        if hasattr(os, "getuid") and (metadata.st_uid != os.getuid() or metadata.st_mode & 0o022):
            _fail("UNSAFE_PATH", "Artifact staging must be owned by the Fusion user and not writable by other users")
    return path


def _file_sha256(path):
    digest = hashlib.sha256()
    size = 0
    descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        current = path.lstat()
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino)):
            _fail("UNSAFE_PATH", "Artifact is not a stable regular file with exactly one link")
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > _MAX_FILE_BYTES:
                _fail("LIMIT_EXCEEDED", "Artifact exceeds the bounded hashing limit")
            digest.update(block)
        after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        _fail("ARTIFACT_CHANGED", "Artifact changed while hashing")
    return digest.hexdigest(), size


def _approved_file(value, expected_hash, extensions):
    expected = _text(expected_hash, "sha256", 64)
    if not re.fullmatch("[0-9a-f]{64}", expected):
        _fail("INVALID_ARGUMENT", "sha256 must be 64 lowercase hexadecimal characters")
    path = _path(value, extensions, existing=True)
    actual, _ = _file_sha256(path)
    if actual != expected:
        _fail("PROFILE_CHANGED", "Approved source bytes no longer match the reviewed SHA-256")
    return path


def _artifact(path, format_name):
    _path(str(path), existing=True)
    digest, size = _file_sha256(path)
    if size == 0:
        _fail("EMPTY_ARTIFACT", "Autodesk produced an empty artifact", outcome="partial")
    return {"path": str(path), "format": format_name, "sha256": digest, "size_bytes": size,
            "validation": "file_presence_and_hash_only", "engineering_validation": "required"}


@_operation("documents.list", optional=("limit",), document=False, read=True)
def _documents_list(ctx):
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, 256)
    docs = _items(ctx.app.documents, 256)
    return {"session_id": _SESSION, "fusion_version": ctx.app.version,
            "active_command": ctx.app.userInterface.activeCommand,
            "documents": [_document_summary(ctx.app, d) for d in docs[:limit]],
            "total": len(docs), "truncated": len(docs) > limit,
            "execution": "main_thread_reviewed_handler", "live_qualification": "not_inferred"}


@_operation("documents.create", optional=("name",), document=False)
def _documents_create(ctx):
    name = _text(ctx.args["name"], "name", 256) if "name" in ctx.args else None
    ctx.before()
    doc = ctx.call(ctx.app.documents.add, _api().core.DocumentTypes.FusionDesignDocumentType)
    ctx.effect("Created an unsaved Fusion design document and changed the active tab")
    ctx.doc, ctx.document_id = doc, _document_id(doc)
    ctx.design = _product(doc, "DesignProductType")
    if name:
        doc.name = name
    return _document_summary(ctx.app, doc)


def _exact_data_file(ctx):
    lineage = _text(ctx.args["data_file_id"], "data_file_id", 2048)
    version = _text(ctx.args["expected_version_id"], "expected_version_id", 2048)
    file = ctx.app.data.findFileById(version)
    if file is None:
        _fail("DATA_FILE_NOT_FOUND", "The exact authorized DataFile version was not found or is inaccessible")
    if file.versionId != version or lineage not in (file.id, file.versionId):
        _fail("VERSION_MISMATCH", "DataFile lineage and exact version do not match the authorized target")
    return file


@_operation("documents.open", ("data_file_id", "expected_version_id"), document=False)
def _documents_open(ctx):
    file = _exact_data_file(ctx)
    ctx.before()
    doc = ctx.call(ctx.app.documents.open, file, True)
    ctx.effect("Opened the exact authorized cloud DataFile version and activated its tab")
    ctx.doc, ctx.document_id = doc, _document_id(doc)
    ctx.design = _product(doc, "DesignProductType", False)
    if doc.dataFile is None or doc.dataFile.versionId != file.versionId:
        _fail("VERSION_MISMATCH", "Opened document version differs from the requested version", outcome="partial")
    return _document_summary(ctx.app, doc)


@_operation("documents.import", ("format", "source_path", "source_sha256", "input_trust"), document=False)
def _documents_import(ctx):
    format_name = _enum(ctx.args["format"], ("step", "f3d"), "format")
    if ctx.args["input_trust"] != "approved_trusted":
        _fail("ISOLATED_IMPORT_REQUIRED", "This route shares the running Fusion process; untrusted supplier parsing requires a separately qualified isolated environment")
    extensions = (".step", ".stp") if format_name == "step" else (".f3d",)
    path = _approved_file(ctx.args["source_path"], ctx.args["source_sha256"], extensions)
    if path.stat().st_size > 256 * 1024 * 1024:
        _fail("LIMIT_EXCEEDED", "Desktop import input exceeds the reviewed 256 MiB bound; size checks do not establish parser isolation")
    manager = ctx.app.importManager
    options = manager.createSTEPImportOptions(str(path)) if format_name == "step" else manager.createFusionArchiveImportOptions(str(path))
    if options is None:
        _fail("UNSUPPORTED", "This Fusion build cannot create the released import options for the requested format")
    options.isViewFit = False
    ctx.before()
    _approved_file(str(path), ctx.args["source_sha256"], extensions)
    document = ctx.call(manager.importToNewDocument, options)
    ctx.effect("Imported approved source bytes into a new unsaved document; the existing Fusion process and UI are shared")
    ctx.doc, ctx.document_id = document, _document_id(document)
    ctx.design = _product(document, "DesignProductType")
    return {"document": _document_summary(ctx.app, document), "source_sha256": ctx.args["source_sha256"],
            "format": format_name, "source_path": str(path), "isolation": "shared_fusion_process",
            "cloud_save_requested": False, "design_mode_conversion": False,
            "risk": "A native translator crash can affect all open documents. A new document is not a parser sandbox.",
            "validation": "Reinspect scale, topology, mass and format-specific round-trip fidelity before use"}


@_operation("documents.activate")
def _documents_activate(ctx):
    ctx.before(editable=False, active=False)
    ctx.call(ctx.doc.activate)
    ctx.effect("Activated the explicitly selected document tab")
    return _document_summary(ctx.app, ctx.doc)


@_operation("documents.close", ("discard_unsaved",))
def _documents_close(ctx):
    if _boolean(ctx.args["discard_unsaved"], "discard_unsaved"):
        _fail("DESTRUCTIVE_CLOSE_DENIED", "This operation never discards unsaved edits; explicitly save and verify first")
    if ctx.doc.isModified:
        _fail("UNSAVED_CHANGES", "Save and verify the document before closing it")
    ctx.before(editable=False, active=False)
    # close(False) does not save; the guard above forbids modified documents.
    ctx.call(ctx.doc.close, False)
    ctx.effect("Closed an unmodified document without creating a cloud save")
    return {"closed_document_id": ctx.document_id}


@_operation("documents.save", ("description",), ("name", "folder_id"))
def _documents_save(ctx):
    description = _text(ctx.args["description"], "description", 2048, allow_empty=True)
    saved = ctx.doc.isSaved
    folder = None
    name = None
    if saved and ("name" in ctx.args or "folder_id" in ctx.args):
        _fail("INVALID_ARGUMENT", "A previously saved document uses save; implicit Save As or relocation is not allowed")
    if not saved:
        if "name" not in ctx.args or "folder_id" not in ctx.args:
            _fail("SAVE_AS_REQUIRED", "An unsaved document requires an explicit name and authorized folder_id")
        name = _text(ctx.args["name"], "name", 256)
        folder = ctx.app.data.findFolderById(_text(ctx.args["folder_id"], "folder_id", 2048))
        if folder is None or folder.id != ctx.args["folder_id"]:
            _fail("FOLDER_NOT_FOUND", "The authorized save destination was not found or is inaccessible")
    before = _cloud_identity(ctx.doc)
    ctx.before()
    if saved:
        ctx.call(ctx.doc.save, description)
    else:
        ctx.call(ctx.doc.saveAs, name, folder, description, "")
    ctx.effect("Requested a cloud document save; server processing can continue asynchronously")
    return {"document": _document_summary(ctx.app, ctx.doc), "previous_cloud_version": before,
            "save_requested": True, "cloud_completion_verified": bool(ctx.doc.dataFile and ctx.doc.dataFile.isComplete),
            "verification": "Reinspect DataFile identity/completion and cloud version; save return is not a lifecycle release"}


@_operation("document.inspect", optional=("limit",), read=True)
def _document_inspect(ctx):
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    result = _document_summary(ctx.app, ctx.doc)
    if ctx.design is not None:
        design = ctx.design
        result.update({"configuration": _configuration(design), "design_type": int(design.designType),
                       "root_component": _entity_summary(ctx, design.rootComponent, "component"),
                       "internal_units": {"length": "cm", "angle": "rad", "mass": "kg"},
                       "display_length_unit": design.unitsManager.defaultLengthUnits,
                       "parameter_count": design.allParameters.count,
                       "component_count": design.allComponents.count,
                       "timeline": {"count": design.timeline.count, "marker": design.timeline.markerPosition} if design.timeline is not None else None})
        comps = _items(design.allComponents)
        result["components"] = [_entity_summary(ctx, c, "component") for c in comps[:limit]]
        result["components_truncated"] = len(comps) > limit
    result["freshness_semantics"] = "Bounded observation fingerprint, not an Autodesk lock or universal revision counter"
    return result


@_operation("parameters.list", optional=("kind", "limit"), read=True)
def _parameters_list(ctx):
    design = ctx.require_design()
    kind = _enum(ctx.args.get("kind", "user"), ("user", "all"), "kind")
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    parameters = _items(design.userParameters if kind == "user" else design.allParameters)
    return {"parameters": [dict(_parameter_observation(p), parameter_id=_register(ctx, p, "parameter")) for p in parameters[:limit]],
            "total": len(parameters), "truncated": len(parameters) > limit,
            "units_note": "Numeric values are in Fusion internal units; modify using explicit expressions"}


@_operation("parameters.set", ("changes",))
def _parameters_set(ctx):
    design = ctx.require_design(True)
    changes = _array(ctx.args["changes"], "changes", maximum=200)
    parameters, values = [], []
    local = _items(design.allParameters)
    for change in changes:
        _fields(change, ("parameter_id", "expression"), label="parameter change")
        parameter = _resolve(ctx, change["parameter_id"], ("adsk::fusion::UserParameter", "adsk::fusion::ModelParameter"), True)
        if not any(_same(parameter, p) for p in local):
            _fail("EXTERNAL_REFERENCE_READ_ONLY", "Batch parameters must be local to the authorized Design")
        if any(_same(parameter, p) for p in parameters):
            _fail("INVALID_ARGUMENT", "The same parameter cannot occur twice in one batch")
        values.append(_value_input(ctx, change["expression"], parameter.unit))
        parameters.append(parameter)
    ctx.before()
    ctx.attempting = True
    # Design_modifyParameters.htm documents all-or-none for local parameters.
    accepted = design.modifyParameters(parameters, values)
    if not accepted:
        ctx.attempting = False
        _fail("PARAMETER_BATCH_REJECTED", "Fusion rejected the atomic parameter batch; none of its parameters were updated")
    ctx.effect("Updated all %d parameters using Design.modifyParameters" % len(parameters))
    return {"parameters": [dict(_parameter_observation(p), parameter_id=_register(ctx, p, "parameter")) for p in parameters],
            "atomicity": "Documented all-or-none parameter batch within one Design"}


@_operation("parameters.add", ("name", "expression", "unit"), ("comment",))
def _parameters_add(ctx):
    design = ctx.require_design(True)
    name = _text(ctx.args["name"], "name", 128)
    unit = _text(ctx.args["unit"], "unit", 64, allow_empty=True)
    comment = _text(ctx.args.get("comment", ""), "comment", 2048, allow_empty=True)
    if design.allParameters.itemByName(name) is not None:
        _fail("NAME_EXISTS", "A parameter with this exact name already exists")
    value = _value_input(ctx, ctx.args["expression"], unit)
    ctx.before()
    parameter = ctx.call(design.userParameters.add, name, value, unit, comment)
    ctx.effect("Added one editable user parameter")
    return dict(_parameter_observation(parameter), parameter_id=_register(ctx, parameter, "parameter"))


_ENTITY_KINDS = ("component", "occurrence", "body", "face", "edge", "sketch", "profile",
                 "parameter", "feature", "sketch_line", "sketch_circle", "sketch_point",
                 "construction_axis", "construction_plane")


@_operation("entities.find", ("kind",), ("parent_id", "name", "limit", "offset"), read=True)
def _entities_find(ctx):
    design = ctx.require_design()
    kind = _enum(ctx.args["kind"], _ENTITY_KINDS, "kind")
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, _MAX_SCAN)
    name = _text(ctx.args["name"], "name", 256) if "name" in ctx.args else None
    parent = _resolve(ctx, ctx.args["parent_id"]) if "parent_id" in ctx.args else None
    budget = _Budget()
    if kind == "component":
        if parent is not None:
            _fail("INVALID_ARGUMENT", "Components are scoped by document; use occurrence queries for assembly structure")
        objects = budget.items(design.allComponents)
    elif kind == "parameter":
        if parent is not None:
            _fail("INVALID_ARGUMENT", "Parameter discovery is scoped by document")
        objects = budget.items(design.allParameters)
    elif kind in ("face", "edge"):
        if not _is(parent, "adsk::fusion::BRepBody"):
            _fail("PARENT_REQUIRED", "Face and edge discovery require an exact parent body handle")
        objects = budget.items(parent.faces if kind == "face" else parent.edges)
    elif kind in ("profile", "sketch_line", "sketch_circle", "sketch_point"):
        if not _is(parent, "adsk::fusion::Sketch"):
            _fail("PARENT_REQUIRED", "Sketch geometry discovery requires an exact parent sketch handle")
        if kind == "profile":
            objects = budget.items(parent.profiles)
        elif kind == "sketch_line":
            objects = budget.items(parent.sketchCurves.sketchLines)
        elif kind == "sketch_circle":
            objects = budget.items(parent.sketchCurves.sketchCircles)
        else:
            objects = budget.items(parent.sketchPoints)
    else:
        if parent is None:
            parent = design.rootComponent
        if kind == "body" and _is(parent, "adsk::fusion::Occurrence"):
            objects = budget.items(parent.bRepBodies)
        elif not _is(parent, "adsk::fusion::Component"):
            _fail("WRONG_ENTITY_TYPE", "This discovery kind requires a parent component handle")
        elif kind == "body":
            objects = budget.items(parent.bRepBodies)
        elif kind == "sketch":
            objects = budget.items(parent.sketches)
        elif kind == "feature":
            objects = budget.items(parent.features)
        elif kind == "occurrence":
            objects = budget.items(parent.allOccurrences)
        elif kind == "construction_axis":
            objects = [parent.xConstructionAxis, parent.yConstructionAxis, parent.zConstructionAxis]
            objects += budget.items(parent.constructionAxes)
        else:
            objects = [parent.xYConstructionPlane, parent.xZConstructionPlane, parent.yZConstructionPlane]
            objects += budget.items(parent.constructionPlanes)
    if name is not None:
        objects = [obj for obj in objects if _optional(obj, "name") == name]
    page = objects[offset:offset + limit]
    return {"entities": [_entity_summary(ctx, obj, kind) for obj in page], "total": len(objects),
            "offset": offset, "next_offset": offset + limit if offset + limit < len(objects) else None,
            "name_filter_semantics": "Exact discovery filter only; mutations require opaque handles"}


def _measurement_frame(ctx, entities):
    # Keep physical/bounding results in explicitly identified frames. For
    # pairwise measurements the reviewed variant is native, one component.
    if any(_optional(obj, "assemblyContext") is not None for obj in entities):
        _fail("UNSUPPORTED_CONTEXT", "Pairwise measurement across assembly proxies requires a separately qualified frame mapping; select native entities in one component")
    comp = _owner_component(ctx, entities, editable=False)
    return {"kind": "component", "component_id": _register(ctx, comp, "component")}


@_operation("geometry.measure", ("kind", "entity_ids"), ("accuracy",), read=True)
def _geometry_measure(ctx):
    ctx.require_design()
    kind = _enum(ctx.args["kind"], ("physical", "distance", "angle", "bounding_box"), "kind")
    entities = _resolve_many(ctx, ctx.args["entity_ids"], maximum=100)
    if kind == "physical":
        accuracy = _enum(ctx.args.get("accuracy", "high"), ("low", "medium", "high", "very_high"), "accuracy")
        levels = _api().fusion.CalculationAccuracy
        level = {"low": levels.LowCalculationAccuracy, "medium": levels.MediumCalculationAccuracy,
                 "high": levels.HighCalculationAccuracy, "very_high": levels.VeryHighCalculationAccuracy}[accuracy]
        results = []
        for entity in entities:
            if not _is(entity, "adsk::fusion::BRepBody", "adsk::fusion::Component", "adsk::fusion::Occurrence"):
                _fail("WRONG_ENTITY_TYPE", "Physical properties require a body, component, or occurrence")
            props = entity.getPhysicalProperties(level)
            if props is None:
                _fail("API_REJECTED", "Physical properties were unavailable")
            results.append({"entity": _entity_summary(ctx, entity), "mass": {"value": props.mass, "unit": "kg"},
                            "volume": {"value": props.volume, "unit": "cm^3"}, "area": {"value": props.area, "unit": "cm^2"},
                            "center_of_mass": {"point": _point_data(props.centerOfMass), "unit": "cm", "frame": _geometry_frame(ctx, entity)},
                            "density": {"value": props.density, "unit": "kg/cm^3"}, "accuracy": accuracy})
        return {"measurements": results, "material_assumption": "Uses materials assigned in the selected model; verify engineering material data"}
    if kind == "bounding_box":
        results = []
        for entity in entities:
            box = _optional(entity, "boundingBox")
            if box is None:
                _fail("WRONG_ENTITY_TYPE", "Selected entity does not expose a bounding box")
            results.append({"entity": _entity_summary(ctx, entity), "bounding_box": _bbox_data(box, _geometry_frame(ctx, entity))})
        return {"measurements": results}
    if len(entities) != 2:
        _fail("INVALID_ARGUMENT", "Distance/angle measurement requires exactly two entities")
    frame = _measurement_frame(ctx, entities)
    if kind == "distance":
        measure = ctx.app.measureManager.measureMinimumDistance(entities[0], entities[1])
        unit = "cm"
    else:
        measure = ctx.app.measureManager.measureAngle(entities[0], entities[1])
        unit = "rad"
    if measure is None:
        _fail("API_REJECTED", "The selected geometry does not support this measurement")
    result = {"value": measure.value, "unit": unit, "frame": frame,
              "position_unit": "cm", "position_one": _point_data(measure.positionOne), "position_two": _point_data(measure.positionTwo)}
    if kind == "angle":
        result["position_three"] = _point_data(measure.positionThree)
    return result


@_operation("geometry.check", ("kind",), ("entity_ids",), read=True)
def _geometry_check(ctx):
    design = ctx.require_design()
    kind = _enum(ctx.args["kind"], ("health", "interference"), "kind")
    if kind == "health":
        if "entity_ids" in ctx.args:
            entities = _resolve_many(ctx, ctx.args["entity_ids"], maximum=200)
        else:
            budget = _Budget()
            entities = [feature for component in budget.items(design.allComponents) for feature in budget.items(component.features)]
        if len(entities) > _MAX_RESULT:
            _fail("LIMIT_EXCEEDED", "Select a bounded set of features for a complete health result")
        records = []
        for entity in entities:
            if _optional(entity, "healthState") is None:
                _fail("WRONG_ENTITY_TYPE", "Feature health inspection requires a feature that exposes healthState")
            records.append(_entity_summary(ctx, entity, "feature"))
        return {"features": records, "recomputed": False,
                "scope": "Existing reported feature health only; no model recompute or engineering certification"}
    if "entity_ids" not in ctx.args:
        _fail("INVALID_ARGUMENT", "Interference analysis requires explicit body/occurrence handles")
    entities = _resolve_many(ctx, ctx.args["entity_ids"], ("adsk::fusion::BRepBody", "adsk::fusion::Occurrence"), maximum=50)
    if len(entities) < 2:
        _fail("INVALID_ARGUMENT", "Interference requires at least two bodies or occurrences")
    roots = _items(design.rootComponent.occurrences)
    for entity in entities:
        occurrence = entity if _is(entity, "adsk::fusion::Occurrence") else _optional(entity, "assemblyContext")
        if occurrence is None:
            if not _same(entity.parentComponent, design.rootComponent):
                _fail("UNSUPPORTED_CONTEXT", "Interference cannot infer placement of a native body from a child component; select an exact rooted occurrence/proxy")
            continue
        for _ in range(64):
            parent = _optional(occurrence, "assemblyContext")
            if parent is None:
                break
            occurrence = parent
        else:
            _fail("LIMIT_EXCEEDED", "Interference occurrence context exceeds the reviewed nesting bound")
        if not any(_same(occurrence, root) for root in roots):
            _fail("UNSUPPORTED_CONTEXT", "Interference requires occurrence context rooted in the explicit document, not an unplaced native child instance")
    analysis_input = design.createInterferenceInput(_object_collection(entities))
    if analysis_input is None:
        _fail("API_REJECTED", "Fusion could not create the interference input")
    results = design.analyzeInterference(analysis_input)
    if results is None:
        _fail("API_REJECTED", "Fusion could not compute interference")
    records = []
    for result in _items(results, _MAX_RESULT):
        records.append({"entity_one": _register(ctx, result.entityOne), "entity_two": _register(ctx, result.entityTwo),
                        "volume": {"value": result.interferenceBody.volume, "unit": "cm^3"}})
    # Do not call results.createBodies(), including in direct modeling designs.
    return {"interferences": records, "scope": "Static CAD interference, not machine collision simulation or tolerance analysis"}


def _planar(face):
    if not _is(face.geometry, "adsk::core::Plane"):
        _fail("WRONG_ENTITY_TYPE", "This operation requires a planar face")


@_operation("sketches.create", ("plane",), ("component_id", "name"))
def _sketches_create(ctx):
    comp = _component(ctx, ctx.args.get("component_id"), True)
    plane = ctx.args["plane"]
    if isinstance(plane, str):
        plane = {"xy": comp.xYConstructionPlane, "xz": comp.xZConstructionPlane,
                 "yz": comp.yZConstructionPlane}[_enum(plane, ("xy", "xz", "yz"), "plane")]
    else:
        _fields(plane, ("entity_id",), label="plane")
        plane = _resolve(ctx, plane["entity_id"], ("adsk::fusion::BRepFace", "adsk::fusion::ConstructionPlane"), True)
        if _is(plane, "adsk::fusion::BRepFace"):
            _planar(plane)
        if not _same(_owner_component(ctx, [plane]), comp):
            _fail("UNSUPPORTED_CONTEXT", "The support plane must belong to the sketch's component")
    name = _text(ctx.args["name"], "name", 256) if "name" in ctx.args else None
    ctx.before()
    sketch = ctx.call(comp.sketches.add, plane)
    ctx.effect("Created a sketch on the explicitly selected component plane")
    if name:
        sketch.name = name
    return _entity_summary(ctx, sketch, "sketch")


@_operation("sketches.draw", ("sketch_id", "frame", "curves"))
def _sketches_draw(ctx):
    ctx.require_design(True)
    sketch = _resolve(ctx, ctx.args["sketch_id"], ("adsk::fusion::Sketch",), True)
    _owner_component(ctx, [sketch])
    _enum(ctx.args["frame"], ("sketch",), "frame")
    curves = _array(ctx.args["curves"], "curves", maximum=100)
    prepared = []
    for curve in curves:
        if not isinstance(curve, dict):
            _fail("INVALID_ARGUMENT", "Each sketch curve must be a typed object")
        kind = _enum(curve.get("kind"), ("line", "circle", "rectangle"), "curve.kind")
        if kind == "line":
            _fields(curve, ("kind", "start", "end"), label="line")
            start, end = _point(ctx, curve["start"], 2), _point(ctx, curve["end"], 2)
            if sum((a - b) ** 2 for a, b in zip(_point_data(start), _point_data(end))) < 1e-18:
                _fail("INVALID_GEOMETRY", "A sketch line must have nonzero length")
            prepared.append((kind, start, end))
        elif kind == "circle":
            _fields(curve, ("kind", "center", "radius"), label="circle")
            prepared.append((kind, _point(ctx, curve["center"], 2), _expression(ctx, curve["radius"], "cm", "radius", True)[1]))
        else:
            _fields(curve, ("kind", "corner1", "corner2"), label="rectangle")
            first, second = _point(ctx, curve["corner1"], 2), _point(ctx, curve["corner2"], 2)
            if abs(first.x - second.x) < 1e-9 or abs(first.y - second.y) < 1e-9:
                _fail("INVALID_GEOMETRY", "Rectangle corners must define nonzero width and height")
            prepared.append((kind, first, second))
    ctx.before()
    created = []
    for kind, first, second in prepared:
        if kind == "line":
            result = ctx.call(sketch.sketchCurves.sketchLines.addByTwoPoints, first, second)
            created.append(result)
        elif kind == "circle":
            result = ctx.call(sketch.sketchCurves.sketchCircles.addByCenterRadius, first, second)
            created.append(result)
        else:
            result = ctx.call(sketch.sketchCurves.sketchLines.addTwoPointRectangle, first, second)
            created.extend(_items(result, 4))
        ctx.effect("Created sketch " + kind)
    return {"sketch": _entity_summary(ctx, sketch, "sketch"),
            "curves": [_entity_summary(ctx, c) for c in created],
            "profiles": [_entity_summary(ctx, p, "profile") for p in _items(sketch.profiles, _MAX_RESULT)],
            "constraints": "Rectangle uses Fusion's rectangle constraints; other curves require explicit dimensions/constraints",
            "atomicity": "Multiple API edits; partial effects are reported on failure"}


@_operation("sketches.dimension", ("sketch_id", "kind", "entity_ids", "text_position", "expression"), ("orientation",))
def _sketches_dimension(ctx):
    ctx.require_design(True)
    sketch = _resolve(ctx, ctx.args["sketch_id"], ("adsk::fusion::Sketch",), True)
    _owner_component(ctx, [sketch])
    kind = _enum(ctx.args["kind"], ("distance", "diameter", "radial"), "kind")
    allowed = ("adsk::fusion::SketchPoint",) if kind == "distance" else ("adsk::fusion::SketchCircle",)
    entities = _resolve_many(ctx, ctx.args["entity_ids"], allowed, True, 2)
    if len(entities) != (2 if kind == "distance" else 1) or any(not _same(e.parentSketch, sketch) for e in entities):
        _fail("INVALID_ARGUMENT", "Dimensions require the correct number of entities from the exact selected sketch")
    point = _point(ctx, ctx.args["text_position"], 2)
    value = _value_input(ctx, ctx.args["expression"], "cm", positive=True)
    orientation = _enum(ctx.args.get("orientation", "aligned"), ("horizontal", "vertical", "aligned"), "orientation")
    orientations = _api().fusion.DimensionOrientations
    orientation = {"horizontal": orientations.HorizontalDimensionOrientation, "vertical": orientations.VerticalDimensionOrientation,
                   "aligned": orientations.AlignedDimensionOrientation}[orientation]
    ctx.before()
    if kind == "distance":
        dimension = ctx.call(sketch.sketchDimensions.addDistanceDimension, entities[0], entities[1], orientation, point, True)
    elif kind == "diameter":
        dimension = ctx.call(sketch.sketchDimensions.addDiameterDimension, entities[0], point, True)
    else:
        dimension = ctx.call(sketch.sketchDimensions.addRadialDimension, entities[0], point, True)
    ctx.effect("Created one driving sketch dimension")
    ctx.attempting = True
    if not ctx.design.modifyParameters([dimension.parameter], [value]):
        ctx.attempting = False
        _fail("DIMENSION_VALUE_REJECTED", "The dimension exists but Fusion rejected the requested expression", outcome="partial")
    ctx.effect("Set the new dimension's expression")
    return {"dimension_id": _register(ctx, dimension), "parameter_id": _register(ctx, dimension.parameter, "parameter"),
            "expression": dimension.parameter.expression, "sketch": _entity_summary(ctx, sketch, "sketch")}


@_operation("sketches.constrain", ("sketch_id", "constraints"))
def _sketches_constrain(ctx):
    ctx.require_design(True)
    sketch = _resolve(ctx, ctx.args["sketch_id"], ("adsk::fusion::Sketch",), True)
    _owner_component(ctx, [sketch])
    prepared = []
    constraints = _array(ctx.args["constraints"], "constraints", maximum=100)
    kinds = ("coincident", "horizontal", "vertical", "parallel", "perpendicular", "collinear",
             "concentric", "equal", "tangent", "midpoint", "horizontal_points", "vertical_points")
    point_type = "adsk::fusion::SketchPoint"
    line_type = "adsk::fusion::SketchLine"
    circle_type = "adsk::fusion::SketchCircle"
    for constraint in constraints:
        _fields(constraint, ("kind", "entity_ids"), label="constraint")
        kind = _enum(constraint["kind"], kinds, "constraint.kind")
        objects = _resolve_many(ctx, constraint["entity_ids"], (point_type, line_type, circle_type), True, 2)
        required = 1 if kind in ("horizontal", "vertical") else 2
        if len(objects) != required or any(not _same(obj.parentSketch, sketch) for obj in objects):
            _fail("WRONG_ENTITY_TYPE", "A constraint requires the correct number of entities in the exact selected sketch")
        types = tuple(_type(o) for o in objects)
        if kind in ("horizontal", "vertical") and types != (line_type,):
            _fail("WRONG_ENTITY_TYPE", "Horizontal/vertical constraints require one sketch line")
        if kind in ("parallel", "perpendicular", "collinear") and types != (line_type, line_type):
            _fail("WRONG_ENTITY_TYPE", "Parallel/perpendicular/collinear constraints require two sketch lines")
        if kind in ("horizontal_points", "vertical_points") and types != (point_type, point_type):
            _fail("WRONG_ENTITY_TYPE", "Point alignment constraints require two sketch points")
        if kind == "coincident" and (types[0] != point_type or types[1] not in (point_type, line_type, circle_type)):
            _fail("WRONG_ENTITY_TYPE", "Coincident requires a point followed by a point or supported sketch curve")
        if kind == "midpoint" and types != (point_type, line_type):
            _fail("WRONG_ENTITY_TYPE", "This midpoint variant requires a point and a sketch line")
        if kind == "concentric" and types != (circle_type, circle_type):
            _fail("WRONG_ENTITY_TYPE", "This concentric variant requires two circles")
        if kind == "equal" and types not in ((line_type, line_type), (circle_type, circle_type)):
            _fail("WRONG_ENTITY_TYPE", "Equal requires two lines or two circles of the same type")
        if kind == "tangent" and (point_type in types or circle_type not in types):
            _fail("WRONG_ENTITY_TYPE", "This tangent variant needs supported curves including at least one circle")
        prepared.append((kind, objects))
    collection = sketch.geometricConstraints
    # Literal reviewed method mapping; no caller-selected method reflection.
    methods = {"coincident": collection.addCoincident, "horizontal": collection.addHorizontal,
               "vertical": collection.addVertical, "parallel": collection.addParallel,
               "perpendicular": collection.addPerpendicular, "collinear": collection.addCollinear,
               "concentric": collection.addConcentric, "equal": collection.addEqual,
               "tangent": collection.addTangent, "midpoint": collection.addMidPoint,
               "horizontal_points": collection.addHorizontalPoints, "vertical_points": collection.addVerticalPoints}
    ctx.before()
    created = []
    for kind, objects in prepared:
        constraint = ctx.call(methods[kind], *objects)
        ctx.effect("Added a " + kind + " constraint to the exact selected sketch entities")
        created.append({"kind": kind, "constraint_id": _register(ctx, constraint)})
    return {"constraints": created, "sketch": _entity_summary(ctx, sketch, "sketch"),
            "atomicity": "Multiple constraint edits; partial effects are reported instead of promising universal rollback"}


def _parametric(ctx):
    design = ctx.require_design(True)
    if design.designType != _api().fusion.DesignTypes.ParametricDesignType:
        _fail("UNSUPPORTED_DESIGN_TYPE", "This reviewed authoring variant requires a parametric Design; no automatic design-mode conversion is performed")
    if design.timeline.markerPosition != design.timeline.count:
        _fail("TIMELINE_NOT_AT_END", "Move the timeline to its end explicitly before creating a feature")
    return design


def _feature_operation(value):
    kind = _enum(value, ("new_body", "join", "cut", "intersect"), "operation")
    ops = _api().fusion.FeatureOperations
    return {"new_body": ops.NewBodyFeatureOperation, "join": ops.JoinFeatureOperation,
            "cut": ops.CutFeatureOperation, "intersect": ops.IntersectFeatureOperation}[kind]


def _feature_participants(ctx, comp, feature_input):
    kind = ctx.args["operation"]
    if kind in ("cut", "intersect"):
        if "participant_body_ids" not in ctx.args:
            _fail("PARTICIPANTS_REQUIRED", "Cut/intersection require an explicit list of participating bodies")
        bodies = _resolve_many(ctx, ctx.args["participant_body_ids"], ("adsk::fusion::BRepBody",), True, 100)
        if not _same(_owner_component(ctx, bodies), comp):
            _fail("UNSUPPORTED_CONTEXT", "Participating bodies must be in the profile's native component")
        feature_input.participantBodies = bodies
    elif "participant_body_ids" in ctx.args:
        _fail("INVALID_ARGUMENT", "participant_body_ids applies only to cut and intersect")
    elif kind == "join" and comp.bRepBodies.count != 1:
        _fail("AMBIGUOUS_ENTITY", "Join extrusion/revolution requires a component with exactly one body; use separate-body creation and explicit combine for multi-body designs")


def _added_feature(ctx, collection, feature_input, description):
    name = _text(ctx.args["name"], "name", 256) if "name" in ctx.args else None
    ctx.before()
    feature = ctx.call(collection.add, feature_input)
    ctx.effect(description)
    if name:
        feature.name = name
    return {"feature": _entity_summary(ctx, feature, "feature"),
            "bodies": [_entity_summary(ctx, b, "body") for b in _items(feature.bodies, _MAX_RESULT)],
            "engineering_validation": "Check resulting geometry, feature health and intended dimensions"}


@_operation("features.extrude", ("profile_ids", "distance", "operation"), ("name", "participant_body_ids"))
def _features_extrude(ctx):
    _parametric(ctx)
    profiles = _resolve_many(ctx, ctx.args["profile_ids"], ("adsk::fusion::Profile",), True, 100)
    comp = _owner_component(ctx, profiles)
    if any(not _same(p.parentSketch, profiles[0].parentSketch) for p in profiles):
        _fail("UNSUPPORTED_CONTEXT", "This extrusion variant requires profiles from the same sketch")
    distance = _value_input(ctx, ctx.args["distance"], "cm", "distance", True)
    collection = comp.features.extrudeFeatures
    input_obj = collection.createInput(_object_collection(profiles), _feature_operation(ctx.args["operation"]))
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected the extrusion profile input")
    extent = _api().fusion.DistanceExtentDefinition.create(distance)
    if not input_obj.setOneSideExtent(extent, _api().fusion.ExtentDirections.PositiveExtentDirection):
        _fail("API_REJECTED", "Fusion rejected the extrusion extent")
    _feature_participants(ctx, comp, input_obj)
    return _added_feature(ctx, collection, input_obj, "Created a positive one-sided parametric extrusion")


def _linear_axis(ctx, handle):
    axis = _resolve(ctx, handle, ("adsk::fusion::ConstructionAxis", "adsk::fusion::SketchLine", "adsk::fusion::BRepEdge"), True)
    if _is(axis, "adsk::fusion::BRepEdge") and not _is(axis.geometry, "adsk::core::Line3D"):
        _fail("WRONG_ENTITY_TYPE", "This variant requires a straight edge, sketch line, or construction axis")
    return axis


@_operation("features.revolve", ("profile_ids", "axis_id", "angle", "operation"), ("name", "participant_body_ids"))
def _features_revolve(ctx):
    _parametric(ctx)
    profiles = _resolve_many(ctx, ctx.args["profile_ids"], ("adsk::fusion::Profile",), True, 100)
    axis = _linear_axis(ctx, ctx.args["axis_id"])
    comp = _owner_component(ctx, [*profiles, axis])
    if any(not _same(p.parentSketch, profiles[0].parentSketch) for p in profiles):
        _fail("UNSUPPORTED_CONTEXT", "This revolution variant requires profiles from the same sketch")
    _, angle = _expression(ctx, ctx.args["angle"], "rad", "angle", True)
    if angle > 2 * math.pi + 1e-9:
        _fail("INVALID_ARGUMENT", "Revolution angle must not exceed one full turn")
    collection = comp.features.revolveFeatures
    input_obj = collection.createInput(_object_collection(profiles), axis, _feature_operation(ctx.args["operation"]))
    if input_obj is None or not input_obj.setAngleExtent(False, _value_input(ctx, ctx.args["angle"], "rad")):
        _fail("API_REJECTED", "Fusion rejected the revolution input")
    _feature_participants(ctx, comp, input_obj)
    return _added_feature(ctx, collection, input_obj, "Created a parametric revolution about the explicitly selected native axis")


@_operation("features.hole", ("face_id", "frame", "positions", "diameter", "depth"))
def _features_hole(ctx):
    _parametric(ctx)
    _enum(ctx.args["frame"], ("component",), "frame")
    face = _resolve(ctx, ctx.args["face_id"], ("adsk::fusion::BRepFace",), True)
    _planar(face)
    comp = _owner_component(ctx, [face])
    positions = [_point(ctx, p) for p in _array(ctx.args["positions"], "positions", maximum=50)]
    diameter = _value_input(ctx, ctx.args["diameter"], "cm", "diameter", True)
    depth = _value_input(ctx, ctx.args["depth"], "cm", "depth", True)
    inputs = []
    for point in positions:
        plane = face.geometry
        distance = sum((a - b) * n for a, b, n in zip(_point_data(point), _point_data(plane.origin), _point_data(plane.normal)))
        if abs(distance) > 1e-7:
            _fail("INVALID_FRAME", "Hole positions must lie on the selected face plane in its native component frame")
        input_obj = comp.features.holeFeatures.createSimpleInput(diameter)
        if input_obj is None or not input_obj.setPositionByPoint(face, point) or not input_obj.setDistanceExtent(depth):
            _fail("API_REJECTED", "Fusion rejected the hole input")
        input_obj.participantBodies = [face.body]
        inputs.append(input_obj)
    ctx.before()
    features = []
    for input_obj in inputs:
        feature = ctx.call(comp.features.holeFeatures.add, input_obj)
        ctx.effect("Created one simple blind hole in the explicit participating body")
        features.append(_entity_summary(ctx, feature, "feature"))
    return {"features": features, "position_associativity": "Point3D placement is not associative to a sketch",
            "direction": "Opposite the selected planar face normal", "tip_angle": "Fusion simple-hole default 118 deg",
            "atomicity": "Multiple holes are separate edits; no automatic rollback"}


@_operation("features.fillet", ("edge_ids", "radius"), ("tangent_chain",))
def _features_fillet(ctx):
    _parametric(ctx)
    edges = _resolve_many(ctx, ctx.args["edge_ids"], ("adsk::fusion::BRepEdge",), True, 100)
    comp = _owner_component(ctx, edges)
    radius = _value_input(ctx, ctx.args["radius"], "cm", "radius", True)
    tangent = _boolean(ctx.args.get("tangent_chain", False), "tangent_chain")
    collection = comp.features.filletFeatures
    input_obj = collection.createInput()
    edge_set = input_obj.edgeSetInputs.addConstantRadiusEdgeSet(_object_collection(edges), radius, tangent)
    if edge_set is None:
        _fail("API_REJECTED", "Fusion rejected the constant-radius fillet input")
    return _added_feature(ctx, collection, input_obj, "Created a constant-radius fillet with explicit tangent-chain scope")


@_operation("features.chamfer", ("edge_ids", "distance"), ("tangent_chain",))
def _features_chamfer(ctx):
    _parametric(ctx)
    edges = _resolve_many(ctx, ctx.args["edge_ids"], ("adsk::fusion::BRepEdge",), True, 100)
    comp = _owner_component(ctx, edges)
    distance = _value_input(ctx, ctx.args["distance"], "cm", "distance", True)
    tangent = _boolean(ctx.args.get("tangent_chain", False), "tangent_chain")
    collection = comp.features.chamferFeatures
    input_obj = collection.createInput2()
    if not input_obj.chamferEdgeSets.addEqualDistanceChamferEdgeSet(_object_collection(edges), distance, tangent):
        _fail("API_REJECTED", "Fusion rejected the equal-distance chamfer input")
    return _added_feature(ctx, collection, input_obj, "Created an equal-distance chamfer using the released createInput2 contract")


@_operation("features.shell", ("face_ids", "thickness"))
def _features_shell(ctx):
    _parametric(ctx)
    faces = _resolve_many(ctx, ctx.args["face_ids"], ("adsk::fusion::BRepFace",), True, 100)
    comp = _owner_component(ctx, faces)
    collection = comp.features.shellFeatures
    input_obj = collection.createInput(_object_collection(faces), False)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected the shell input")
    input_obj.insideThickness = _value_input(ctx, ctx.args["thickness"], "cm", "thickness", True)
    return _added_feature(ctx, collection, input_obj, "Shelled the selected bodies inward by removing only the explicitly selected faces")


@_operation("features.combine", ("target_id", "tool_ids", "operation"), ("keep_tools",))
def _features_combine(ctx):
    _parametric(ctx)
    target = _resolve(ctx, ctx.args["target_id"], ("adsk::fusion::BRepBody",), True)
    tools = _resolve_many(ctx, ctx.args["tool_ids"], ("adsk::fusion::BRepBody",), True, 100)
    if any(_same(target, tool) for tool in tools):
        _fail("INVALID_ARGUMENT", "Target body cannot also be a combine tool")
    _enum(ctx.args["operation"], ("join", "cut", "intersect"), "operation")
    comp = _owner_component(ctx, [target, *tools])
    collection = comp.features.combineFeatures
    input_obj = collection.createInput(target, _object_collection(tools))
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected the combine input")
    input_obj.operation = _feature_operation(ctx.args["operation"])
    input_obj.isKeepToolBodies = _boolean(ctx.args.get("keep_tools", True), "keep_tools")
    return _added_feature(ctx, collection, input_obj, "Combined the exact target and tool bodies using the approved operation")


@_operation("features.pattern", ("entity_ids", "axis_id", "quantity", "angle"), ("symmetric",))
def _features_pattern(ctx):
    _parametric(ctx)
    # Body patterns avoid the different compute/selection semantics of features,
    # construction geometry and occurrence pattern instances in this variant.
    bodies = _resolve_many(ctx, ctx.args["entity_ids"], ("adsk::fusion::BRepBody",), True, 100)
    axis = _linear_axis(ctx, ctx.args["axis_id"])
    comp = _owner_component(ctx, [*bodies, axis])
    quantity_expression, quantity = _expression(ctx, ctx.args["quantity"], "", "quantity", True)
    if quantity != int(quantity) or not 2 <= quantity <= 100:
        _fail("INVALID_ARGUMENT", "Pattern quantity expression must evaluate to an integer in [2,100]")
    angle = _value_input(ctx, ctx.args["angle"], "rad", "angle", True)
    if _expression(ctx, ctx.args["angle"], "rad")[1] > 2 * math.pi + 1e-9:
        _fail("INVALID_ARGUMENT", "Circular pattern angle must not exceed one full turn")
    collection = comp.features.circularPatternFeatures
    input_obj = collection.createInput(_object_collection(bodies), axis)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected the circular body pattern input")
    input_obj.quantity = _api().core.ValueInput.createByString(quantity_expression)
    input_obj.totalAngle = angle
    input_obj.isSymmetric = _boolean(ctx.args.get("symmetric", False), "symmetric")
    return _added_feature(ctx, collection, input_obj, "Created a circular body pattern in the native component frame")


def _transform(value):
    _fields(value, ("frame", "matrix", "translation_unit"), label="transform")
    _enum(value["frame"], ("parent",), "transform.frame")
    unit = _enum(value["translation_unit"], ("mm", "cm", "m", "in"), "translation_unit")
    numbers = [_number(n, "matrix element") for n in _array(value["matrix"], "matrix", 16, 16)]
    if any(abs(numbers[i] - expected) > 1e-9 for i, expected in zip((12, 13, 14, 15), (0, 0, 0, 1))):
        _fail("INVALID_TRANSFORM", "Matrix must be affine row-major with last row [0,0,0,1]")
    rows = [numbers[i:i + 3] for i in (0, 4, 8)]
    for i in range(3):
        for j in range(3):
            dot = sum(rows[i][k] * rows[j][k] for k in range(3))
            if abs(dot - (1 if i == j else 0)) > 1e-7:
                _fail("INVALID_TRANSFORM", "Occurrence placement supports rigid transforms only; scale/shear are not allowed")
    determinant = (rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
                   - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
                   + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]))
    if abs(determinant - 1.0) > 1e-7:
        _fail("UNSUPPORTED_CONTEXT", "Reflected occurrence placement is not qualified for this variant")
    scale = {"mm": 0.1, "cm": 1.0, "m": 100.0, "in": 2.54}[unit]
    for index in (3, 7, 11):
        numbers[index] *= scale
    matrix = _api().core.Matrix3D.create()
    if not matrix.setWithArray(numbers):
        _fail("API_REJECTED", "Fusion rejected the placement matrix")
    return matrix


@_operation("components.create", ("name",), ("parent_component_id", "transform"))
def _components_create(ctx):
    _parametric(ctx)
    comp = _component(ctx, ctx.args.get("parent_component_id"), True)
    name = _text(ctx.args["name"], "name", 256)
    transform = _transform(ctx.args["transform"]) if "transform" in ctx.args else _api().core.Matrix3D.create()
    ctx.before()
    occurrence = ctx.call(comp.occurrences.addNewComponent, transform)
    ctx.effect("Created a new component definition and occurrence")
    occurrence.component.name = name
    return {"component": _entity_summary(ctx, occurrence.component, "component"),
            "occurrence": _entity_summary(ctx, occurrence, "occurrence"),
            "grounding_note": "Fusion may ground the first occurrence to its parent; resulting grounding is reported"}


@_operation("components.insert", ("data_file_id", "expected_version_id", "is_referenced", "transform"), ("parent_component_id",))
def _components_insert(ctx):
    _parametric(ctx)
    comp = _component(ctx, ctx.args.get("parent_component_id"), True)
    if not _boolean(ctx.args["is_referenced"], "is_referenced"):
        _fail("UNSUPPORTED", "This insertion variant preserves the external reference; unlinked copies need separate authority")
    file = _exact_data_file(ctx)
    if _optional(file, "isConfiguredDesign", False) or _optional(file, "isConfiguration", False):
        _fail("UNSUPPORTED", "Configured insertion requires the released addFromConfiguration same-project contract; custom configured insertion is preview")
    transform = _transform(ctx.args["transform"])
    ctx.before()
    occurrence = ctx.call(comp.occurrences.addByInsert, file, transform, True)
    ctx.effect("Inserted the exact authorized cloud file version as an external reference")
    return {"occurrence": _entity_summary(ctx, occurrence, "occurrence"),
            "source": {"lineage_id": file.id, "version_id": file.versionId}, "refresh_policy": "No implicit update to latest or link break"}


@_operation("components.transform", ("occurrence_id", "transform"))
def _components_transform(ctx):
    design = _parametric(ctx)
    occurrence = _resolve(ctx, ctx.args["occurrence_id"], ("adsk::fusion::Occurrence",), True)
    # Occurrence has no released parentComponent property. Determine its exact
    # containing definition by collection membership, never by path/name.
    budget = _Budget()
    parents = [component for component in budget.items(design.allComponents)
               if any(_same(candidate, occurrence) for candidate in budget.items(component.occurrences))]
    if len(parents) != 1:
        _fail("UNSUPPORTED_CONTEXT", "The exact editable parent component of the native occurrence cannot be established")
    _component(ctx, _register(ctx, parents[0], "component"), True)
    if occurrence.isGrounded or _optional(occurrence, "isGroundToParent", False):
        _fail("GROUNDED_OCCURRENCE", "The occurrence is grounded; this operation will not change grounding authority")
    if _optional(occurrence, "isDerived", False):
        _fail("DERIVED_OCCURRENCE", "Derived occurrence edits can be overwritten by source updates; this variant refuses them")
    transform = _transform(ctx.args["transform"])
    ctx.before()
    ctx.attempting = True
    occurrence.transform2 = transform
    ctx.effect("Set the exact occurrence placement using transform2")
    if design.snapshots.hasPendingSnapshot:
        ctx.call(design.snapshots.add)
        ctx.effect("Captured the pending occurrence position in the parametric timeline")
    return _entity_summary(ctx, occurrence, "occurrence")


@_operation("joints.create", ("occurrence_ids", "kind"), ("component_id",))
def _joints_create(ctx):
    _parametric(ctx)
    _enum(ctx.args["kind"], ("rigid",), "kind")
    comp = _component(ctx, ctx.args.get("component_id"), True)
    occurrences = _resolve_many(ctx, ctx.args["occurrence_ids"], ("adsk::fusion::Occurrence",), True, 2)
    if len(occurrences) != 2:
        _fail("INVALID_ARGUMENT", "An as-built rigid joint needs exactly two occurrences")
    native_occurrences = _items(comp.occurrences)
    if any(not any(_same(occ, native) for native in native_occurrences) for occ in occurrences):
        _fail("UNSUPPORTED_CONTEXT", "This as-built joint variant requires two direct occurrences of the selected parent component")
    input_obj = comp.asBuiltJoints.createInput(occurrences[0], occurrences[1], None)
    if input_obj is None or not input_obj.setAsRigidJointMotion():
        _fail("API_REJECTED", "Fusion rejected the rigid as-built joint input")
    ctx.before()
    joint = ctx.call(comp.asBuiltJoints.add, input_obj)
    ctx.effect("Created an as-built rigid joint without repositioning the selected occurrences")
    return {"joint": _entity_summary(ctx, joint), "motion": "rigid", "placement": "as_built"}


@_operation("configurations.list", read=True)
def _configurations_list(ctx):
    design = ctx.require_design()
    result = _configuration(design)
    table = design.configurationTopTable if design.isConfiguredDesign else None
    result["rows"] = [{"row_id": row.id, "name": row.name, "active": _same(row, table.activeRow)}
                      for row in _items(table.rows, _MAX_RESULT)] if table else []
    result["edit_policy"] = "Activate the authorized configured master row, then use parameters.set; generated instances are read-only"
    return result


@_operation("configurations.activate", ("row_id",))
def _configurations_activate(ctx):
    design = ctx.require_design(True)
    row_id = _text(ctx.args["row_id"], "row_id", 256)
    if not design.isConfiguredDesign or design.configurationTopTable is None:
        _fail("NOT_CONFIGURED_MASTER", "The document is not a configured master design")
    row = design.configurationTopTable.rows.itemById(row_id)
    if row is None:
        _fail("CONFIGURATION_NOT_FOUND", "The exact configuration row ID does not exist in this master")
    ctx.before()
    ctx.call(row.activate)
    ctx.effect("Activated the exact configuration row; prior entity selections must be reacquired")
    if not _same(design.configurationTopTable.activeRow, row):
        _fail("CONFIGURATION_MISMATCH", "Fusion did not activate the requested row", outcome="partial")
    return _configuration(design)


@_operation("materials.list", optional=("library_id", "limit", "offset"), read=True)
def _materials_list(ctx):
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, _MAX_SCAN)
    if "library_id" not in ctx.args:
        libraries = _items(ctx.app.materialLibraries, _MAX_RESULT)
        return {"libraries": [{"library_id": lib.id, "name": lib.name, "material_count": lib.materials.count} for lib in libraries[offset:offset + limit]],
                "total": len(libraries), "next_offset": offset + limit if offset + limit < len(libraries) else None}
    library = ctx.app.materialLibraries.itemById(_text(ctx.args["library_id"], "library_id", 1024))
    if library is None:
        _fail("LIBRARY_NOT_FOUND", "The exact approved material library ID was not found")
    materials = _items(library.materials)
    budget, gaps, cache = _Budget(), [], []
    records = [_material_observation(material, budget, gaps, cache) for material in materials[offset:offset + limit]]
    return {"library_id": library.id, "materials": records,
            "total": len(materials), "next_offset": offset + limit if offset + limit < len(materials) else None,
            "qualification_scope": "Definition fingerprint only; not certification of engineering property accuracy or suitability",
            "assignment": "Pass the selected qualified material's engineering_sha256 as expected_material_sha256 to materials.assign"}


def _qualified_material(material, expected):
    gaps = []
    observation = _material_observation(material, _Budget(), gaps, [])
    if observation is None or gaps or not observation["qualified"]:
        _fail("FRESHNESS_UNAVAILABLE", "The selected engineering material definition cannot be fully fingerprinted",
              {"gaps": gaps or ["engineering_material:missing_definition"]})
    if observation["engineering_sha256"] != expected:
        _fail("MATERIAL_DEFINITION_CHANGED", "The material's engineering properties differ from the inspected and approved definition",
              {"current_engineering_sha256": observation["engineering_sha256"]})
    return observation


@_operation("materials.assign", ("entity_id", "library_id", "material_id", "expected_material_sha256"))
def _materials_assign(ctx):
    ctx.require_design(True)
    entity = _resolve(ctx, ctx.args["entity_id"], ("adsk::fusion::Component", "adsk::fusion::BRepBody"), True)
    _component(ctx, ctx.args["entity_id"], True) if _is(entity, "adsk::fusion::Component") else _owner_component(ctx, [entity])
    library = ctx.app.materialLibraries.itemById(_text(ctx.args["library_id"], "library_id", 1024))
    if library is None:
        _fail("LIBRARY_NOT_FOUND", "The exact approved library ID was not found")
    material = library.materials.itemById(_text(ctx.args["material_id"], "material_id", 1024))
    if material is None:
        _fail("MATERIAL_NOT_FOUND", "The exact material ID was not found in the approved library")
    expected = _text(ctx.args["expected_material_sha256"], "expected_material_sha256", 64)
    if not re.fullmatch("[a-f0-9]{64}", expected):
        _fail("INVALID_ARGUMENT", "expected_material_sha256 must be 64 lowercase hexadecimal characters")
    _qualified_material(material, expected)
    ctx.before()
    # Re-fetch and fingerprint the library definition after the document guard,
    # immediately before the API assignment, without assuming immutable IDs.
    material = library.materials.itemById(ctx.args["material_id"])
    _qualified_material(material, expected)
    ctx.attempting = True
    entity.material = material
    ctx.effect("Submitted the explicit engineering material assignment; verifying assigned property values")
    # Fusion may copy a library material into the document with a different ID.
    # Physical definition equality, not library-vs-document ID equality, is the
    # postcondition. Failed verification leaves the edit visible as partial.
    assigned = _qualified_material(entity.material, expected)
    ctx.effect("Verified the assigned engineering property definition against the approved material hash")
    return {"entity_id": ctx.args["entity_id"], "assigned_material_id": entity.material.id,
            "source_library_id": library.id, "source_material_id": material.id,
            "engineering_sha256": assigned["engineering_sha256"], "definition_verified": True,
            "scope": "Assigned released engineering property values match the selected definition; appearance/texture contents and material suitability are not certified"}


@_operation("exports.generate", ("format", "output_path"), ("entity_id", "unit", "mesh_refinement"))
def _exports_generate(ctx):
    design = ctx.require_design()
    format_name = _enum(ctx.args["format"], ("step", "stl", "f3d"), "format")
    extensions = {"step": (".step", ".stp"), "stl": (".stl",), "f3d": (".f3d",)}
    path = _path(ctx.args["output_path"], extensions[format_name])
    types = ("adsk::fusion::BRepBody", "adsk::fusion::Component", "adsk::fusion::Occurrence") if format_name == "stl" else ("adsk::fusion::Component",)
    geometry = _resolve(ctx, ctx.args["entity_id"], types) if "entity_id" in ctx.args else design.rootComponent
    manager = design.exportManager
    if format_name != "stl" and ("unit" in ctx.args or "mesh_refinement" in ctx.args):
        _fail("INVALID_ARGUMENT", "unit and mesh_refinement are specific to STL output")
    if format_name == "step":
        options = manager.createSTEPExportOptions(str(path), geometry)
        fidelity = "Neutral BRep exchange; no Fusion parametric timeline or material/metadata parity is promised"
    elif format_name == "f3d":
        if any(occ.isReferencedComponent for occ in _items(geometry.allOccurrences)):
            _fail("ASSEMBLY_ARCHIVE_REQUIRED", "An assembly with external references needs a separately qualified assembly package export; F3D is not F3Z")
        options = manager.createFusionArchiveExportOptions(str(path), geometry)
        fidelity = "Native component archive; references and target Fusion compatibility still require reopen qualification"
    else:
        options = manager.createSTLExportOptions(geometry, str(path))
        if options is None:
            _fail("API_REJECTED", "Fusion could not create STL export options")
        unit = _enum(ctx.args.get("unit", "mm"), ("mm", "cm", "m", "in"), "unit")
        refinement = _enum(ctx.args.get("mesh_refinement", "high"), ("low", "medium", "high"), "mesh_refinement")
        units = _api().fusion.DistanceUnits
        levels = _api().fusion.MeshRefinementSettings
        options.unitType = {"mm": units.MillimeterDistanceUnits, "cm": units.CentimeterDistanceUnits,
                            "m": units.MeterDistanceUnits, "in": units.InchDistanceUnits}[unit]
        options.meshRefinement = {"low": levels.MeshRefinementLow, "medium": levels.MeshRefinementMedium, "high": levels.MeshRefinementHigh}[refinement]
        options.isBinaryFormat = True
        options.isOneFilePerBody = False
        options.sendToPrintUtility = False
        fidelity = "Tessellated surface approximation; STL does not encode units, design history, or engineering material"
    if options is None:
        _fail("API_REJECTED", "Fusion could not create the requested export options")
    ctx.before(editable=False)
    _path(str(path), extensions[format_name])
    ctx.call(manager.execute, options)
    ctx.effect("Exported the exact selected geometry to a new local staging file")
    artifact = _artifact(path, format_name)
    artifact["fidelity"] = fidelity
    if format_name == "stl":
        artifact.update({"unit": unit, "mesh_refinement": refinement, "binary": True,
                         "surface_deviation_cm": options.surfaceDeviation, "normal_deviation_rad": options.normalDeviation,
                         "maximum_edge_length_cm": options.maximumEdgeLength})
    return {"artifact": artifact, "source_document_id": ctx.document_id, "entity_id": _register(ctx, geometry)}


@_operation("drawings.export_pdf", ("output_path", "all_sheets"))
def _drawings_export_pdf(ctx):
    if not _boolean(ctx.args["all_sheets"], "all_sheets"):
        _fail("UNSUPPORTED", "This released PDF variant exports all sheets; selection-dependent export is not exposed")
    drawing_api = _namespace("drawing")
    drawing_doc = drawing_api.DrawingDocument.cast(ctx.doc)
    if drawing_doc is None:
        _fail("WRONG_PRODUCT", "Existing drawing PDF export requires an explicit DrawingDocument")
    path = _path(ctx.args["output_path"], (".pdf",))
    manager = drawing_doc.drawing.exportManager
    options = manager.createPDFExportOptions(str(path))
    if options is None:
        _fail("API_REJECTED", "Fusion could not create PDF export options")
    options.sheetsToExport = drawing_api.PDFSheetsExport.AllPDFSheetsExport
    options.openPDF = False
    options.useLineWeights = True
    ctx.before(editable=False)
    _path(str(path), (".pdf",))
    ctx.call(manager.execute, options)
    ctx.effect("Exported all sheets of the selected existing drawing without opening an external PDF application")
    return {"artifact": _artifact(path, "pdf"), "sheets": "all", "line_weights": True,
            "drawing_creation": "Not performed; automatic drawing authoring is a separate preview capability"}


def _viewport(ctx):
    viewport = ctx.app.activeViewport
    if viewport is None or not _same(viewport.parentDocument, ctx.doc):
        _fail("DOCUMENT_NOT_ACTIVE", "The active viewport does not belong to the exact requested document")
    return viewport


@_operation("view.capture", ("output_path", "width", "height"), ("fit",))
def _view_capture(ctx):
    if _boolean(ctx.args.get("fit", False), "fit"):
        _fail("UNSUPPORTED", "This capture variant preserves the current view; automatic camera fitting is not enabled")
    path = _path(ctx.args["output_path"], (".png", ".jpg", ".jpeg", ".tiff"))
    width = _integer(ctx.args["width"], "width", 108, 4000)
    height = _integer(ctx.args["height"], "height", 108, 4000)
    viewport = _viewport(ctx)
    camera = viewport.camera
    ctx.before(editable=False)
    _path(str(path), (".png", ".jpg", ".jpeg", ".tiff"))
    ctx.call(viewport.saveAsImageFile, str(path), width, height)
    ctx.effect("Captured the selected document's current viewport to a new local image")
    return {"artifact": _artifact(path, path.suffix[1:]), "width": width, "height": height,
            "camera": {"eye_cm": _point_data(camera.eye), "target_cm": _point_data(camera.target), "up": _point_data(camera.upVector)},
            "camera_changed": False, "measurement_evidence": False}


def _register_job(ctx, kind, future, **extra):
    if len(_JOBS) >= _MAX_JOBS:
        _fail("LIMIT_EXCEEDED", "Session job registry is full; consume results and restart/reconnect only after existing jobs complete", outcome="partial")
    job_id = "job_" + uuid.uuid4().hex
    _JOBS[job_id] = {"kind": kind, "document_id": ctx.document_id, "future": future, **extra}
    return job_id


def _get_job(ctx, kind):
    job_id = _text(ctx.args["job_id"], "job_id", 128)
    job = _JOBS.get(job_id)
    if job is None or job["kind"] != kind or job["document_id"] != ctx.document_id:
        _fail("JOB_NOT_FOUND", "Job is unknown, is from another session/document, or has a different result kind", outcome="unknown")
    if not _valid(job["future"]):
        _fail("JOB_INTERRUPTED", "The Fusion job future is no longer valid; no cancellation or success is inferred", outcome="unknown")
    return job_id, job


@_operation("render.start", ("output_path", "width", "height", "quality"))
def _render_start(ctx):
    design = ctx.require_design()
    path = _path(ctx.args["output_path"], (".png", ".jpg", ".jpeg", ".tiff"))
    width = _integer(ctx.args["width"], "width", 108, 4000)
    height = _integer(ctx.args["height"], "height", 108, 4000)
    quality = _enum(ctx.args["quality"], ("draft", "standard", "excellent"), "quality")
    if len(_JOBS) >= _MAX_JOBS:
        _fail("LIMIT_EXCEEDED", "Too many tracked jobs; complete existing jobs before starting another")
    viewport = _viewport(ctx)
    rendering = design.renderManager.rendering
    # Properties exist on released Rendering, not on startLocalRender arguments.
    saved = (rendering.aspectRatio, rendering.resolutionWidth, rendering.resolutionHeight, rendering.renderQuality)
    ctx.before(editable=False)
    future, job_id = None, None
    try:
        ctx.attempting = True
        rendering.aspectRatio = _api().fusion.RenderAspectRatios.CustomRenderAspectRatio
        rendering.resolutionWidth = width
        rendering.resolutionHeight = height
        rendering.renderQuality = {"draft": 25, "standard": 75, "excellent": 100}[quality]
        ctx.effect("Set explicit local rendering resolution and quality")
        _path(str(path), (".png", ".jpg", ".jpeg", ".tiff"))
        future = ctx.call(rendering.startLocalRender, str(path), viewport.camera)
        job_id = _register_job(ctx, "render", future, path=str(path), width=width, height=height)
        ctx.effect("Started local render " + job_id + " with a nonempty local destination; no cloud render destination requested")
    finally:
        # Restore both custom dimensions before the original aspect constraint.
        try:
            rendering.aspectRatio = _api().fusion.RenderAspectRatios.CustomRenderAspectRatio
            rendering.resolutionWidth = saved[1]
            rendering.resolutionHeight = saved[2]
            rendering.aspectRatio = saved[0]
            rendering.renderQuality = saved[3]
        except Exception as error:
            _fail("RENDER_SETTINGS_RESTORE_FAILED", "Fusion could not restore all prior rendering settings; inspect settings before another render",
                  {"job_id": job_id, "restore_error": str(error)[:512],
                   "recovery": "Use render.status with the tracked job_id if present; a settings failure does not cancel a submitted render"}, outcome="partial")
    return {"job_id": job_id, "status": "queued", "provider_state": int(future.renderState),
            "cancel_supported": False, "output_path": str(path), "cloud_destination": False,
            "lifetime": "Tied to this running Fusion session; closing Fusion interrupts the render"}


@_operation("render.status", ("job_id",), read=True)
def _render_status(ctx):
    job_id, job = _get_job(ctx, "render")
    future = job["future"]
    states = _api().fusion.LocalRenderStates
    state = future.renderState
    statuses = {states.QueuedLocalRenderState: "queued", states.ProcessingLocalRenderState: "running",
                states.FinishedLocalRenderState: "succeeded", states.FailedLocalRenderState: "failed"}
    status = statuses.get(state, "outcome_unknown")
    result = {"job_id": job_id, "status": status, "progress": future.progress, "cancel_supported": False,
              "width": future.imageWidth, "height": future.imageHeight, "output_path": job["path"]}
    if status == "succeeded":
        if future.imageWidth != job["width"] or future.imageHeight != job["height"]:
            _fail("RENDER_SIZE_MISMATCH", "Completed render dimensions differ from the approved render inputs", outcome="partial")
        if Path(future.filename) != Path(job["path"]):
            _fail("RENDER_DESTINATION_MISMATCH", "Render future destination differs from the approved local path", outcome="partial")
        result["artifact"] = _artifact(Path(job["path"]), Path(job["path"]).suffix[1:])
    return result


@_operation("flatpattern.create", ("stationary_face_id",), ("component_id",))
def _flatpattern_create(ctx):
    _parametric(ctx)
    comp = _component(ctx, ctx.args.get("component_id"), True)
    face = _resolve(ctx, ctx.args["stationary_face_id"], ("adsk::fusion::BRepFace",), True)
    _planar(face)
    if not _same(face.body.parentComponent, comp):
        _fail("WRONG_COMPONENT", "The stationary face must belong to the explicitly selected component")
    if not face.body.isSheetMetal:
        _fail("NOT_SHEET_METAL", "The body is not sheet metal; preview conversion is not performed")
    if comp.flatPattern is not None:
        _fail("FLAT_PATTERN_EXISTS", "A flat pattern already exists; inspect/export it without recreating it")
    ctx.before()
    flat_pattern = ctx.call(comp.createFlatPattern, face)
    ctx.effect("Created a flat pattern using the explicit stationary planar face")
    return {"flat_pattern": _entity_summary(ctx, flat_pattern, "feature"),
            "flat_body": _entity_summary(ctx, flat_pattern.flatBody, "body"),
            "manufacturing_review": "Verify stationary face, thickness, sheet-metal rule, bends, K-factor and bend allowance against the approved source"}


@_operation("flatpattern.export", ("output_path",), ("component_id",))
def _flatpattern_export(ctx):
    comp = _component(ctx, ctx.args.get("component_id"))
    if comp.flatPattern is None:
        _fail("FLAT_PATTERN_NOT_FOUND", "Create or select an existing released flat pattern first")
    path = _path(ctx.args["output_path"], (".dxf",))
    manager = ctx.design.exportManager
    options = manager.createDXFFlatPatternExportOptions(str(path), comp.flatPattern)
    if options is None:
        _fail("API_REJECTED", "Fusion rejected flat-pattern DXF export options")
    ctx.before(editable=False)
    _path(str(path), (".dxf",))
    ctx.call(manager.execute, options)
    ctx.effect("Exported the selected existing flat pattern through the released DXF export API")
    return {"artifact": _artifact(path, "dxf"), "source_flat_pattern_id": _register(ctx, comp.flatPattern),
            "scope": "Flat-pattern DXF; retired Sketch.saveAsDXF and preview sketch DXF replacement are not called"}


_CAM_SUPPORTED_STRATEGIES = ("face", "adaptive", "parallel")
_CAM_VALUE_TYPES = {
    "string": "adsk::cam::StringParameterValue", "boolean": "adsk::cam::BooleanParameterValue",
    "integer": "adsk::cam::IntegerParameterValue", "float": "adsk::cam::FloatParameterValue",
    "choice": "adsk::cam::ChoiceParameterValue",
}
_CAM_SELECTION_TYPES = ("adsk::fusion::BRepBody", "adsk::fusion::Occurrence", "adsk::fusion::BRepFace",
                        "adsk::fusion::BRepEdge", "adsk::fusion::SketchPoint", "adsk::fusion::SketchLine",
                        "adsk::fusion::ConstructionAxis", "adsk::fusion::ConstructionPlane")


def _cam_setup(ctx, handle):
    cam = ctx.require_cam()
    setup = _resolve(ctx, handle, ("adsk::cam::Setup",))
    if not any(_same(setup, item) for item in _items(cam.setups)):
        _fail("STALE_ENTITY", "The CAM setup is no longer present in this document")
    if setup.operationType != _namespace("cam").OperationTypes.MillingOperation:
        _fail("UNSUPPORTED", "This operation family currently qualifies milling setups only")
    return setup


def _cam_parameters_data(parameters, limit, offset=0):
    all_parameters = _items(parameters)
    rows = []
    for parameter in all_parameters[offset:offset + limit]:
        row = _cam_parameter_observation(parameter)
        row["system_default_expression"] = parameter.systemDefaultExpression
        if _is(parameter.value, "adsk::cam::ChoiceParameterValue"):
            success, names, values = parameter.value.getChoices()
            if not success or len(names) != len(values) or len(values) > _MAX_RESULT:
                _fail("UNSUPPORTED", "CAM choice metadata could not be qualified")
            row["choices"] = [{"label": name, "value": value} for name, value in zip(names, values)]
        rows.append(row)
    return {"parameters": rows, "total": len(all_parameters),
            "next_offset": offset + limit if offset + limit < len(all_parameters) else None}


def _cam_required(parameters, setup=False):
    required = []
    for p in _items(parameters):
        if not p.isEditable or p.isDeprecated or not p.isEnabled:
            continue
        if setup:
            critical = p.name.startswith(("wcs_", "job_stock", "job_wcs"))
        else:
            critical = p.name.startswith(("tool_spindle", "tool_feed", "tool_coolant", "clearanceHeight_", "retractHeight_", "topHeight_", "bottomHeight_"))
            critical = critical or p.name in ("tolerance", "maximumStepdown", "stepover", "stockToLeave", "verticalStockToLeave")
        if critical:
            required.append(p.name)
    return required


def _validate_cam_defaults(parameters, supplied, setup=False):
    required = _cam_required(parameters, setup)
    missing = set(required) - supplied
    changed_defaults = []
    for p in _items(parameters):
        if not p.isEditable or p.isDeprecated or not p.isEnabled or p.name in supplied:
            continue
        # Tool geometry/metadata comes from the exact tool JSON, not a shared
        # library edit. Feeds/speeds above are still mandatory explicit inputs.
        if not setup and p.name.startswith("tool_"):
            continue
        if _is(p.value, *_CAM_VALUE_TYPES.values()) and p.expression != p.systemDefaultExpression:
            changed_defaults.append(p.name)
    if missing or changed_defaults:
        _fail("EXPLICIT_CAM_INPUTS_REQUIRED", "CAM safety inputs and non-system user defaults must be reviewed explicitly; use the schema discovery operation",
              {"missing_safety_parameters": sorted(missing), "unreviewed_default_overrides": changed_defaults})


def _apply_cam_parameters(ctx, parameters, changes):
    changes = _array(changes, "parameters", 0, 500)
    prepared = []
    supplied = set()
    for change in changes:
        _fields(change, ("name", "type", "value"), label="CAM parameter")
        name = _text(change["name"], "parameter.name", 256)
        if name in supplied:
            _fail("INVALID_ARGUMENT", "Duplicate CAM parameter name")
        supplied.add(name)
        parameter = parameters.itemByName(name)
        if parameter is None or not parameter.isEditable or parameter.isDeprecated:
            _fail("UNSUPPORTED_CAM_PARAMETER", "CAM parameter is missing, deprecated, or not editable", {"name": name})
        kind = _enum(change["type"], (*_CAM_VALUE_TYPES, "expression", "selection"), "parameter.type")
        value = change["value"]
        if kind == "expression":
            if not _is(parameter.value, *_CAM_VALUE_TYPES.values()):
                _fail("WRONG_PARAMETER_TYPE", "Expressions cannot stand in for geometry selection or complex CAM values")
            value = _text(value, "parameter.expression", 1024)
        elif kind == "selection":
            if not _is(parameter.value, "adsk::cam::CadObjectParameterValue", "adsk::cam::CadContours2dParameterValue"):
                _fail("WRONG_PARAMETER_TYPE", "This parameter does not accept the reviewed CAD-object/one-chain selection variant")
            value = _resolve_many(ctx, value, _CAM_SELECTION_TYPES, maximum=100)
            if _is(parameter.value, "adsk::cam::CadContours2dParameterValue") and any(not _is(e, "adsk::fusion::BRepEdge", "adsk::fusion::SketchLine") for e in value):
                _fail("WRONG_PARAMETER_TYPE", "A CAM chain selection requires ordered edges or sketch lines")
        else:
            if not _is(parameter.value, _CAM_VALUE_TYPES[kind]):
                _fail("WRONG_PARAMETER_TYPE", "CAM parameter value type differs from the requested typed value", {"name": name, "actual": _type(parameter.value)})
            if kind == "boolean":
                value = _boolean(value, "parameter.value")
            elif kind == "integer":
                value = _integer(value, "parameter.value", -2147483648, 2147483647)
            elif kind == "float":
                # CAM FloatParameterValue uses internal units; the contract
                # deliberately reports this. Dimensioned values should be an
                # explicit expression instead of unqualified numeric input.
                value = _number(value, "parameter.value")
            else:
                value = _text(value, "parameter.value", 4096, allow_empty=kind == "string")
        prepared.append((parameter, kind, value))
    # All shape/type/entity checks precede writes to these transient input or
    # post parameter objects. Final Fusion error checks precede model creation.
    for parameter, kind, value in prepared:
        if kind == "expression":
            parameter.expression = value
        elif kind == "selection":
            if _is(parameter.value, "adsk::cam::CadObjectParameterValue"):
                parameter.value.value = value
            else:
                chains = parameter.value.getCurveSelections()
                # Work on a fresh input only; inherited chain selections would
                # be a hidden additional target, so refuse them explicitly.
                if chains.count:
                    _fail("AMBIGUOUS_ENTITY", "The CAM input already contains contour selections; use a reviewed template or clear selection in Fusion first")
                chain = chains.createNewChainSelection()
                chain.inputGeometry = value
                parameter.value.applyCurveSelections(chains)
                actual = _items(chain.value, 100)
                if len(actual) != len(value) or any(not _same(a, b) for a, b in zip(actual, value)):
                    _fail("CAM_SELECTION_EXPANDED", "Fusion filled or reordered the requested edge chain; explicit target scope must be requalified")
        else:
            if kind == "choice":
                success, _, choices = parameter.value.getChoices()
                if not success or value not in choices:
                    _fail("INVALID_CHOICE", "Requested CAM choice is not one of the exact published values", {"name": parameter.name})
            parameter.value.value = value
    invalid = [{"name": p.name, "error": p.error} for p, _, _ in prepared if p.error]
    if invalid:
        _fail("CAM_PARAMETER_REJECTED", "Fusion reported invalid CAM input parameter values", invalid)
    return supplied


def _cam_strategy(setup, strategy):
    strategy = _enum(strategy, _CAM_SUPPORTED_STRATEGIES, "strategy")
    matches = [s for s in _items(setup.operations.compatibleStrategies) if s.name == strategy]
    if len(matches) != 1:
        _fail("UNSUPPORTED_STRATEGY", "The exact reviewed strategy is not exposed for this setup")
    if not matches[0].isGenerationAllowed:
        _fail("ENTITLEMENT_REQUIRED", "The current Fusion license/extension does not allow generation for this strategy")
    return strategy


def _cam_read_input_context(ctx):
    if ctx.app.userInterface.activeCommand not in _IDLE_COMMANDS or not _same(ctx.app.activeDocument, ctx.doc):
        _fail("FUSION_BUSY", "Inspect transient CAM inputs from the explicit active document with no running UI command")


@_operation("cam.setup_schema", ("operation_type",), ("limit", "offset"), read=True)
def _cam_setup_schema(ctx):
    cam = ctx.require_cam()
    _cam_read_input_context(ctx)
    _enum(ctx.args["operation_type"], ("milling",), "operation_type")
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, _MAX_SCAN)
    input_obj = cam.setups.createInput(_namespace("cam").OperationTypes.MillingOperation)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion could not create transient milling setup input")
    result = _cam_parameters_data(input_obj.parameters, limit, offset)
    result.update({"required_explicit_parameters": _cam_required(input_obj.parameters, True),
                   "float_units": "Fusion CAM internal units; prefer expressions for physical quantities",
                   "created_setup": False, "safety": "Required fields are re-evaluated after mode changes; discovered defaults are not engineering approval"})
    return result


@_operation("cam.operation_schema", ("setup_id", "strategy"), ("limit", "offset"), read=True)
def _cam_operation_schema(ctx):
    setup = _cam_setup(ctx, ctx.args["setup_id"])
    _cam_read_input_context(ctx)
    strategy = _cam_strategy(setup, ctx.args["strategy"])
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, _MAX_SCAN)
    input_obj = setup.operations.createInput(strategy)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion could not create transient operation input")
    result = _cam_parameters_data(input_obj.parameters, limit, offset)
    result.update({"strategy": strategy, "generation_allowed": True,
                   "required_explicit_parameters": _cam_required(input_obj.parameters),
                   "float_units": "Fusion CAM internal units; prefer expressions for physical quantities",
                   "created_operation": False, "safety": "Tool assignment and mode changes can add required explicit inputs"})
    return result


@_operation("cam.inspect", optional=("limit",), read=True)
def _cam_inspect(ctx):
    cam = ctx.require_cam()
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    setups = _items(cam.setups)
    results = []
    remaining = limit
    for setup in setups[:limit]:
        entry = _cam_operation_state(setup)
        entry["setup_id"] = _register(ctx, setup, "cam_setup")
        operations = _items(setup.allOperations)
        entry["operations"] = [dict(_cam_operation_state(op), operation_id=_register(ctx, op, "cam_operation")) for op in operations[:remaining]]
        remaining -= len(entry["operations"])
        entry["operation_count"] = len(operations)
        entry["operations_truncated"] = len(operations) > len(entry["operations"])
        entry["work_coordinate_system"] = {"frame": "model_to_setup", "matrix": list(setup.workCoordinateSystem.asArray()), "translation_unit": "cm", "layout": "row_major"}
        machine = setup.machine
        entry["machine"] = {"id": machine.id, "vendor": machine.vendor, "model": machine.model, "description": machine.description,
                             "definition_hash": "Use an approved source .machine file and equivalentTo for posting"} if machine else None
        entry["models"] = [_entity_summary(ctx, m) for m in _items(setup.models, 100)]
        entry["fixtures"] = [_entity_summary(ctx, m) for m in _items(setup.fixtures, 100)]
        entry["fixture_enabled"] = setup.fixtureEnabled
        entry["stock_mode"] = int(setup.stockMode)
        entry["strategies"] = [{"strategy": s.name, "generation_allowed": s.isGenerationAllowed,
                                 "reviewed_creation_variant": s.name in _CAM_SUPPORTED_STRATEGIES}
                                for s in _items(setup.operations.compatibleStrategies, _MAX_RESULT)]
        results.append(entry)
    return {"setups": results, "total_setups": len(setups), "truncated": len(setups) > len(results),
            "machine_verification": "Not performed; CAD interference is not CAM simulation",
            "validity_refresh": "No CAM.checkValidity call is made because it can invalidate toolpaths"}


@_operation("cam.setup_create", ("name", "model_ids", "fixture_ids", "operation_type", "stock_mode", "parameters"), ("machine_id",))
def _cam_setup_create(ctx):
    ctx.require_design(True)
    cam = ctx.require_cam()
    _enum(ctx.args["operation_type"], ("milling",), "operation_type")
    name = _text(ctx.args["name"], "name", 256)
    models = _resolve_many(ctx, ctx.args["model_ids"], ("adsk::fusion::BRepBody", "adsk::fusion::Occurrence"), maximum=100)
    fixtures_input = _array(ctx.args["fixture_ids"], "fixture_ids", 0, 100)
    fixtures = _resolve_many(ctx, fixtures_input, ("adsk::fusion::BRepBody", "adsk::fusion::Occurrence"), maximum=100) if fixtures_input else []
    if any(_same(model, fixture) for model in models for fixture in fixtures):
        _fail("AMBIGUOUS_ENTITY", "The same object cannot simultaneously be setup model and fixture")
    stock_mode = _enum(ctx.args["stock_mode"], ("relative_box", "fixed_box"), "stock_mode")
    input_obj = cam.setups.createInput(_namespace("cam").OperationTypes.MillingOperation)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected milling setup creation input")
    input_obj.name = name
    input_obj.models = models
    input_obj.fixtureEnabled = bool(fixtures)
    input_obj.fixtures = fixtures
    input_obj.isUsingPreviousSetupData = False
    modes = _namespace("cam").SetupStockModes
    input_obj.stockMode = modes.RelativeBoxStock if stock_mode == "relative_box" else modes.FixedBoxStock
    if "machine_id" in ctx.args:
        machine_id = _text(ctx.args["machine_id"], "machine_id", 256)
        matches = [m for m in _items(cam.allMachines, _MAX_RESULT) if m.id == machine_id]
        if len(matches) != 1:
            _fail("MACHINE_NOT_FOUND", "The exact selected machine must exist unambiguously in this document")
        input_obj.machine = matches[0]
    supplied = _apply_cam_parameters(ctx, input_obj.parameters, ctx.args["parameters"])
    _validate_cam_defaults(input_obj.parameters, supplied, True)
    snapshot = [_cam_parameter_observation(p) for p in _items(input_obj.parameters)]
    ctx.before()
    setup = ctx.call(cam.setups.add, input_obj)
    ctx.effect("Created an ungenerated milling setup with explicit models, fixtures, stock mode and reviewed parameters")
    return {"setup_id": _register(ctx, setup, "cam_setup"), "input_sha256": _hash(snapshot),
            "work_coordinate_system_cm": list(setup.workCoordinateSystem.asArray()), "generated": False,
            "machine_id": _optional(setup.machine, "id"), "physical_release": False}


@_operation("cam.operation_create", ("setup_id", "strategy", "tool_json", "parameters"))
def _cam_operation_create(ctx):
    ctx.require_design(True)
    setup = _cam_setup(ctx, ctx.args["setup_id"])
    strategy = _cam_strategy(setup, ctx.args["strategy"])
    tool_json = _text(ctx.args["tool_json"], "tool_json", 1048576)
    try:
        decoded = json.loads(tool_json)
    except (ValueError, TypeError):
        _fail("INVALID_TOOL", "tool_json must be a valid single-tool Autodesk JSON object")
    if not isinstance(decoded, dict) or ("data" in decoded and (not isinstance(decoded["data"], list) or len(decoded["data"]) != 1)):
        _fail("INVALID_TOOL", "Tool JSON must contain exactly one tool; the API's implicit first-tool selection is not accepted")
    tool = _namespace("cam").Tool.createFromJson(tool_json)
    if not _valid(tool):
        _fail("INVALID_TOOL", "Fusion did not accept the single-tool JSON definition")
    input_obj = setup.operations.createInput(strategy)
    if input_obj is None:
        _fail("API_REJECTED", "Fusion rejected the operation strategy input")
    input_obj.tool = tool
    input_obj.generationMode = _namespace("cam").AutomaticGenerationModes.SkipGeneration
    supplied = _apply_cam_parameters(ctx, input_obj.parameters, ctx.args["parameters"])
    _validate_cam_defaults(input_obj.parameters, supplied)
    snapshot = [_cam_parameter_observation(p) for p in _items(input_obj.parameters)]
    ctx.before()
    operation = ctx.call(setup.operations.add, input_obj)
    ctx.effect("Created one reviewed milling strategy operation with a document-local tool copy; automatic generation was disabled")
    return {"operation_id": _register(ctx, operation, "cam_operation"), "strategy": strategy,
            "input_sha256": _hash(snapshot), "tool_sha256": _hash(decoded), "generated": False,
            "physical_release": False, "shared_library_modified": False}


@_operation("cam.template_apply", ("setup_id", "template_path", "template_sha256"))
def _cam_template_apply(ctx):
    ctx.require_design(True)
    setup = _cam_setup(ctx, ctx.args["setup_id"])
    path = _approved_file(ctx.args["template_path"], ctx.args["template_sha256"], (".f3dhsm-template",))
    template = _namespace("cam").CAMTemplate.createFromFile(str(path))
    if template is None:
        _fail("INVALID_TEMPLATE", "Fusion could not read the exact approved CAM template")
    input_obj = _namespace("cam").CreateFromCAMTemplateInput.create()
    input_obj.camTemplate = template
    input_obj.mode = _namespace("cam").AutomaticGenerationModes.SkipGeneration
    ctx.before()
    _approved_file(str(path), ctx.args["template_sha256"], (".f3dhsm-template",))
    created = ctx.call(setup.createFromCAMTemplate2, input_obj)
    ctx.effect("Applied the exact reviewed template with automatic generation disabled")
    operations = _items(created, _MAX_RESULT)
    if not operations:
        _fail("EMPTY_TEMPLATE_RESULT", "The template returned no operations", outcome="partial")
    return {"created": [dict(_cam_operation_state(op), operation_id=_register(ctx, op, "cam_operation")) for op in operations],
            "template_sha256": ctx.args["template_sha256"], "generated": False,
            "review": "Inspect tool/stock/WCS/geometry resolution before approving generation; imported template content is not machine approval"}


def _cutting_operations(ctx, handles, posting=False):
    ctx.require_cam()
    operations = _resolve_many(ctx, handles, ("adsk::cam::Operation",), maximum=100)
    for op in operations:
        setup = op.parentSetup
        if setup is None or setup.operationType != _namespace("cam").OperationTypes.MillingOperation:
            _fail("UNSUPPORTED", "This generation/posting variant supports concrete milling cutting operations only")
        compatible = [s for s in _items(setup.operations.compatibleStrategies) if s.name == op.strategy]
        if len(compatible) != 1 or not compatible[0].isGenerationAllowed:
            _fail("ENTITLEMENT_REQUIRED", "Selected operation strategy does not have explicit current generation eligibility")
        if op.isSuppressed or op.isGenerating or op.hasError or (posting and op.hasWarning):
            _fail("INVALID_OPERATION_STATE", "Selected operation is suppressed, generating, or has disallowed errors/warnings", _cam_operation_state(op))
        if posting and (not op.hasToolpath or not op.isToolpathValid):
            _fail("INVALID_TOOLPATH", "Posting requires a present, current toolpath for every authorized cutting operation", _cam_operation_state(op))
    return operations


@_operation("cam.generate", ("operation_ids",))
def _cam_generate(ctx):
    ctx.require_design(True)
    cam = ctx.require_cam()
    operations = _cutting_operations(ctx, ctx.args["operation_ids"])
    if len(_JOBS) >= _MAX_JOBS:
        _fail("LIMIT_EXCEEDED", "Too many tracked session jobs")
    ctx.before()
    future = ctx.call(cam.generateToolpath, _object_collection(operations))
    ctx.effect("Started asynchronous toolpath generation for the explicitly selected cutting operations")
    job_id = _register_job(ctx, "cam", future, operation_ids=list(ctx.args["operation_ids"]))
    return {"job_id": job_id, "status": "running", "operation_count": future.numberOfOperations,
            "cancel_supported": False, "physical_release": False}


@_operation("cam.status", ("job_id",), read=True)
def _cam_status(ctx):
    candidate = _JOBS.get(_text(ctx.args["job_id"], "job_id", 128))
    if candidate and candidate["kind"] == "nc_post":
        return _nc_status(ctx)
    if candidate and candidate["kind"] == "setup_sheet":
        return _setup_sheet_status(ctx)
    job_id, job = _get_job(ctx, "cam")
    future = job["future"]
    result = {"job_id": job_id, "status": "running", "operation_count": future.numberOfOperations,
              "completed": future.numberOfCompleted, "cancel_supported": False}
    if future.isGenerationCompleted:
        operations = _resolve_many(ctx, job["operation_ids"], ("adsk::cam::Operation",), maximum=100)
        result["operations"] = [_cam_operation_state(op) for op in operations]
        valid = all(op.hasToolpath and op.isToolpathValid and not op.hasError and not op.isSuppressed for op in operations)
        result["status"] = "succeeded" if valid else "failed"
        result["result_validation"] = "Each authorized cutting operation needs a current non-error toolpath; future completion alone is insufficient"
    return result


def _cam_control(parameters, name, value, expected_type):
    """Fixed NC controls, independent of model-supplied post parameters."""
    parameter = parameters.itemByName(name)
    if parameter is None or not parameter.isEditable or parameter.isDeprecated:
        _fail("UNSUPPORTED_POST_CONTROL", "A mandatory released NC control is unavailable or not editable", {"name": name})
    actual_type = _type(parameter.value)
    if expected_type == "string" and actual_type == "adsk::cam::ChoiceParameterValue":
        success, _, choices = parameter.value.getChoices()
        if not success or value not in choices:
            _fail("UNSUPPORTED_POST_CONTROL", "The required NC control value is unavailable", {"name": name})
    elif actual_type != _CAM_VALUE_TYPES[expected_type]:
        _fail("UNSUPPORTED_POST_CONTROL", "The mandatory NC control has an unqualified value type", {"name": name, "type": actual_type})
    parameter.value.value = value
    if parameter.error or parameter.value.value != value:
        _fail("POST_CONTROL_REJECTED", "Fusion did not accept an explicit mandatory NC control", {"name": name})


def _nc_units(parameters, units):
    parameter = parameters.itemByName("nc_program_unit")
    if parameter is None or not _is(parameter.value, "adsk::cam::ChoiceParameterValue"):
        _fail("UNSUPPORTED_POST_CONTROL", "The NC program must expose its unit as a qualified choice parameter")
    success, _, values = parameter.value.getChoices()
    # Select only exact semantic values actually advertised by this build. Never
    # choose by localized label, collection position, or undocumented enum int.
    aliases = {"mm": ("mm", "millimeters", "millimeter"), "in": ("in", "inches", "inch")}[units]
    matches = [value for value in values if value in aliases] if success else []
    if len(matches) != 1:
        _fail("UNSUPPORTED_POST_CONTROL", "The requested NC unit has no unambiguous published choice value", {"requested_unit": units})
    _cam_control(parameters, "nc_program_unit", matches[0], "string")
    return matches[0]


def _validate_nc_tools(operations, approved_definitions=None):
    tools_by_number = {}
    tools = []
    for operation in operations:
        tool = operation.tool
        if tool is None:
            _fail("TOOL_REQUIRED", "Every posted cutting operation needs an explicit tool")
        number_parameter = tool.parameters.itemByName("tool_number")
        if number_parameter is None or not _is(number_parameter.value, "adsk::cam::IntegerParameterValue"):
            _fail("TOOL_NUMBER_REQUIRED", "The posted tool needs an exact positive integer tool number")
        number = _integer(number_parameter.value.value, "tool_number", 1, 100000)
        definition = _tool_definition(tool)
        digest = definition["definition_sha256"]
        if number in tools_by_number and tools_by_number[number] != digest:
            _fail("DUPLICATE_TOOL_NUMBER", "Distinct tool definitions share a tool number; posting is blocked", {"tool_number": number})
        tools_by_number[number] = digest
        if approved_definitions is not None and digest not in approved_definitions:
            _fail("TOOL_LIBRARY_MISMATCH", "A complete operation tool/holder definition does not match any tool in the approved pinned library",
                  {"operation_vendor_id": operation.operationId, "tool_number": number, "definition_sha256": digest})
        if approved_definitions is not None and definition["holder_sha256"] is None:
            _fail("HOLDER_DEFINITION_REQUIRED", "NC posting requires a complete holder definition in both the operation tool and approved library")
        tools.append({"operation_vendor_id": operation.operationId, "tool_number": number,
                      "tool_sha256": digest, "holder_sha256": definition["holder_sha256"]})
    return tools


def _post_safety_options():
    cam_api = _namespace("cam")
    options = cam_api.NCProgramPostProcessOptions.create()
    if options is None:
        _fail("UNSUPPORTED_POST_CONTROL", "NCProgramPostProcessOptions is unavailable")
    options.postProcessExecutionBehavior = cam_api.PostProcessExecutionBehaviors.PostProcessExecutionBehavior_Fail
    options.isFailOnToolNumberDuplication = True
    # This does not itself disable hub export. The separate required NC boolean
    # is explicitly false, checked again after post and machine assignment.
    options.fusionHubExecutionBehavior = cam_api.FusionHubExecutionBehaviors.FusionHubExecutionBehavior_SkipRelationship
    if (options.postProcessExecutionBehavior != cam_api.PostProcessExecutionBehaviors.PostProcessExecutionBehavior_Fail or
            not options.isFailOnToolNumberDuplication or
            options.fusionHubExecutionBehavior != cam_api.FusionHubExecutionBehaviors.FusionHubExecutionBehavior_SkipRelationship):
        _fail("POST_CONTROL_REJECTED", "Required fail-on-invalid/duplicate-tool safeguards did not remain enabled")
    return options


def _nc_candidate_state(ctx, program):
    """Observe the actual candidate controls independently of source toolpaths."""
    budget, gaps = _Budget(), []
    observation = {"operation_id": program.operationId,
                   "order": [operation.operationId for operation in budget.items(program.filteredOperations)],
                   "parameters": [_cam_parameter_observation(p, ctx, budget, gaps) for p in budget.items(program.parameters)],
                   "post_parameters": [_cam_parameter_observation(p, ctx, budget, gaps) for p in budget.items(program.postParameters)],
                   "machine": _machine_observation(ctx, program.machine)}
    if gaps:
        _fail("FRESHNESS_UNAVAILABLE", "The API cannot establish complete reviewed NC program controls", {"gaps": sorted(set(gaps))}, outcome="partial")
    return _hash(observation)


def _nc_artifacts(job):
    folder = _path(job["folder"], directory=True)
    files = list(folder.iterdir())
    if len(files) > 100 or any(not p.is_file() for p in files):
        _fail("UNEXPECTED_POST_OUTPUT", "Post output must be a bounded set of regular files in the approved quarantine directory", outcome="partial")
    if sum(p.stat().st_size for p in files) > _MAX_FILE_BYTES:
        _fail("LIMIT_EXCEEDED", "NC artifact set exceeds the reviewed aggregate size bound", outcome="partial")
    principal = folder / job["principal_filename"]
    if principal not in files:
        _fail("POST_OUTPUT_MISSING", "The expected principal NC candidate file was not produced", outcome="partial")
    artifacts = [_artifact(path, "nc" if path == principal else "nc_auxiliary") for path in sorted(files)]
    return artifacts


def _nc_status(ctx):
    job_id, job = _get_job(ctx, "nc_post")
    state = _optional(ctx.app, "hasActiveJobs")
    if state is None:
        _fail("POST_COMPLETION_UNVERIFIABLE", "This build does not expose active job completion; inspect the NC candidate manually", outcome="unknown")
    if state:
        return {"job_id": job_id, "status": "validating", "cancel_supported": False,
                "provider_scope": "Fusion reports active background jobs; no per-post future/cancellation API is assumed"}
    if job["future"].hasError:
        return {"job_id": job_id, "status": "failed", "error": job["future"].error, "cancel_supported": False}
    current, gaps = _state(ctx)
    if gaps or current != job["candidate_state"]:
        _fail("POST_SOURCE_CHANGED", "The candidate source changed while export completion was pending; revalidate before any release", outcome="unknown")
    if (_nc_candidate_state(ctx, job["future"]) != job["program_state"] or
            not _same(job["future"].postConfiguration, job["post_configuration"])):
        _fail("POST_PROGRAM_CHANGED", "NC controls, operation ordering, post parameters, machine, or post selection changed after submission", outcome="unknown")
    try:
        _approved_file(job["post_path"], job["post_sha256"], (".cps",))
        _approved_file(job["machine_path"], job["machine_sha256"], (".machine",))
        _approved_file(job["tool_library_path"], job["tool_library_sha256"], (".json",))
    except FusionError as error:
        _fail("POST_PROFILE_CHANGED", "Reviewed post, machine, or tool-library bytes changed during asynchronous posting",
              {"cause": error.code}, outcome="unknown")
    artifacts = _nc_artifacts(job)
    return {"job_id": job_id, "status": "succeeded", "artifacts": artifacts, "cancel_supported": False,
            "post_sha256": job["post_sha256"], "machine_sha256": job["machine_sha256"],
            "tool_library_sha256": job["tool_library_sha256"],
            "operator_verification": job["verification"], "physical_release": False,
            "release_state": "quarantined_candidate", "transfer_to_equipment": "not_performed"}


@_operation("cam.nc_post", ("operation_ids", "post_config_path", "post_sha256", "output_folder", "program_name", "units", "machine_profile", "tool_library", "verification"), ("parameters",))
def _cam_nc_post(ctx):
    ctx.require_design(True)
    cam = ctx.require_cam()
    operations = _cutting_operations(ctx, ctx.args["operation_ids"], posting=True)
    if len(_JOBS) >= _MAX_JOBS:
        _fail("LIMIT_EXCEEDED", "Too many tracked session jobs")
    if _optional(ctx.app, "hasActiveJobs") is not False:
        _fail("FUSION_BUSY", "Posting requires a qualified idle Fusion job state before submission")
    program_name = _text(ctx.args["program_name"], "program_name", 64)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", program_name):
        _fail("INVALID_ARGUMENT", "Program name must be a safe NC file stem")
    units = _enum(ctx.args["units"], ("mm", "in"), "units")
    folder = _path(ctx.args["output_folder"], directory=True)
    if any(folder.iterdir()):
        _fail("OUTPUT_EXISTS", "NC output requires a new empty private quarantine directory")
    post_path = _approved_file(ctx.args["post_config_path"], ctx.args["post_sha256"], (".cps",))
    profile = _fields(ctx.args["machine_profile"], ("id", "sha256", "source_path"), label="machine_profile")
    machine_id = _text(profile["id"], "machine_profile.id", 256)
    machine_path = _approved_file(profile["source_path"], profile["sha256"], (".machine",))
    verification = _fields(ctx.args["verification"], ("method", "reviewed_by", "source_state"), label="verification")
    _text(verification["method"], "verification.method", 1024)
    _text(verification["reviewed_by"], "verification.reviewed_by", 256)
    if verification["source_state"] != ctx.request.get("expected_state"):
        _fail("VERIFICATION_STALE", "The operator verification must bind to the exact approved source state")
    tool_library, tool_library_path, approved_definitions = _approved_tool_library(ctx.args["tool_library"])
    tools = _validate_nc_tools(operations, approved_definitions)
    manager = _namespace("cam").CAMManager.get().libraryManager
    machine = manager.machineLibrary.machineAtURL(_api().core.URL.create(machine_path.as_uri()))
    if machine is None or machine.id != machine_id:
        _fail("MACHINE_PROFILE_UNAVAILABLE", "The approved local machine definition could not be loaded with its exact ID")
    for op in operations:
        actual = op.parentSetup.machine
        if actual is None or actual.id != machine_id or not actual.equivalentTo(machine):
            _fail("MACHINE_PROFILE_CHANGED", "Every selected operation setup must use a machine equivalent to the reviewed definition")
    post = manager.postLibrary.postConfigurationAtURL(_api().core.URL.create(post_path.as_uri()))
    if post is None:
        _fail("POST_PROFILE_UNAVAILABLE", "The exact approved local post configuration could not be loaded; no library import or substitution was attempted")
    extension = _text(post.extension, "post.extension", 16).lstrip(".")
    if not re.fullmatch(r"[A-Za-z0-9]{1,12}", extension):
        _fail("UNSAFE_POST_EXTENSION", "The approved post's principal output extension is not a safe file extension")
    options = _post_safety_options()
    nc_input = cam.ncPrograms.createInput()
    if nc_input is None:
        _fail("API_REJECTED", "Fusion rejected NC program input creation")
    nc_input.displayName = program_name
    nc_input.operations = operations
    # Assign operations before program name: setup program defaults can modify
    # the name when the operations collection is first assigned.
    controls = (("nc_program_name", program_name, "string"),
                ("nc_program_filename", program_name, "string"),
                ("nc_program_nc_extension", extension, "string"),
                ("nc_program_output_folder", folder.as_posix(), "string"),
                ("nc_program_openInEditor", False, "boolean"),
                ("nc_program_postToFusionTeam", False, "boolean"),
                ("nc_program_orderByTool", False, "boolean"))
    for name, value, kind in controls:
        _cam_control(nc_input.parameters, name, value, kind)
    unit_choice = _nc_units(nc_input.parameters, units)
    # Caller overrides apply to post parameters only, never these output,
    # filtering, unit, ordering or cloud controls.
    post_changes = _array(ctx.args.get("parameters", []), "parameters", 0, 500)
    if any(isinstance(p, dict) and str(p.get("name", "")).startswith("nc_program_") for p in post_changes):
        _fail("POST_CONTROL_OVERRIDE_DENIED", "NC output and safety controls cannot be overridden through post parameters")
    ctx.before()
    _approved_file(str(post_path), ctx.args["post_sha256"], (".cps",))
    _approved_file(str(machine_path), profile["sha256"], (".machine",))
    nc_program = ctx.call(cam.ncPrograms.add, nc_input)
    ctx.effect("Created an NC candidate program with explicit local output and no Fusion Hub upload")
    nc_program.machine = machine
    nc_program.postConfiguration = post
    # Assigning machine/post can change defaults; reapply and verify every
    # mandatory control on the actual NC program, not only its transient input.
    for name, value, kind in controls:
        _cam_control(nc_program.parameters, name, value, kind)
    _nc_units(nc_program.parameters, units)
    if post_changes:
        post_parameters = nc_program.postParameters
        _apply_cam_parameters(ctx, post_parameters, post_changes)
        ctx.call(nc_program.updatePostParameters, post_parameters)
        ctx.effect("Applied the exact reviewed post parameter overrides")
    actual_operations = _items(nc_program.filteredOperations, 100)
    actual_order = [op.operationId for op in actual_operations]
    approved_order = [op.operationId for op in operations]
    if actual_order != approved_order:
        _fail("NC_OPERATION_ORDER_MISMATCH", "Fusion's filtered/grouped NC operation list differs from the approved ordered list", {"approved": approved_order, "actual": actual_order}, outcome="partial")
    # Recheck cutting results and machine equivalence immediately before the
    # posting API boundary. No event loop/yield or arbitrary callback runs here.
    _cutting_operations(ctx, ctx.args["operation_ids"], posting=True)
    tool_library, tool_library_path, approved_definitions = _approved_tool_library(ctx.args["tool_library"])
    _validate_nc_tools(operations, approved_definitions)
    for op in operations:
        if not op.parentSetup.machine.equivalentTo(machine):
            _fail("MACHINE_PROFILE_CHANGED", "A selected setup machine changed before posting", outcome="partial")
    _approved_file(str(post_path), ctx.args["post_sha256"], (".cps",))
    _approved_file(str(machine_path), profile["sha256"], (".machine",))
    _path(str(folder), directory=True)
    if any(folder.iterdir()):
        _fail("OUTPUT_EXISTS", "Quarantine output directory changed before posting", outcome="partial")
    program_state = _nc_candidate_state(ctx, nc_program)
    if not _same(nc_program.postConfiguration, post):
        _fail("POST_PROFILE_CHANGED", "The actual NC program no longer selects the exact reviewed post configuration", outcome="partial")
    ctx.call(nc_program.postProcess, options)
    ctx.effect("Autodesk accepted post processing with Fail behavior, duplicate-tool checks, no editor launch and no hub export")
    candidate_state, gaps = _state(ctx)
    if gaps:
        _fail("FRESHNESS_UNAVAILABLE", "Candidate freshness could not be established after posting", outcome="partial")
    job_id = _register_job(ctx, "nc_post", nc_program, folder=str(folder), principal_filename=program_name + "." + extension,
                           candidate_state=candidate_state, post_sha256=ctx.args["post_sha256"], machine_sha256=profile["sha256"],
                           program_state=program_state, post_configuration=post, post_path=str(post_path), machine_path=str(machine_path),
                           tool_library_path=str(tool_library_path),
                           tool_library_sha256=ctx.args["tool_library"]["sha256"],
                           verification=dict(verification))
    result = {"job_id": job_id, "nc_program_id": _register(ctx, nc_program, "nc_program"),
              "status": "validating", "post_accepted": True, "cancel_supported": False, "tool_definitions": tools,
              "operation_order": actual_order, "units": units, "unit_choice": unit_choice,
              "post_sha256": ctx.args["post_sha256"], "machine_sha256": profile["sha256"],
              "tool_library_sha256": ctx.args["tool_library"]["sha256"],
              "source_state": ctx.request["expected_state"], "candidate_state": candidate_state,
              "output_folder": str(folder), "cloud_upload": False, "physical_release": False,
              "next_step": "Poll cam.status; inspect candidate output and follow the authorized shop prove-out/release process"}
    if not ctx.app.hasActiveJobs:
        if (_nc_candidate_state(ctx, nc_program) != program_state or not _same(nc_program.postConfiguration, post)):
            _fail("POST_PROGRAM_CHANGED", "NC program controls changed while posting; the output remains an unverified candidate", outcome="partial")
        result["artifacts"] = _nc_artifacts(_JOBS[job_id])
        result["status"] = "succeeded"
        result["release_state"] = "quarantined_candidate"
    return result


def _tool_definition(tool):
    raw = _text(tool.toJson(), "Tool.toJson", 1048576)
    decoded = json.loads(raw)
    if not isinstance(decoded, dict):
        _fail("UNSUPPORTED_TOOL_SERIALIZATION", "The current Tool.toJson representation is not a JSON object")
    payload = decoded
    if "data" in payload:
        if not isinstance(payload["data"], list) or len(payload["data"]) != 1 or not isinstance(payload["data"][0], dict):
            _fail("UNSUPPORTED_TOOL_SERIALIZATION", "One tool serialization must not implicitly contain several tools")
        payload = payload["data"][0]
    holder = payload.get("holder")
    return {"definition_sha256": _hash(decoded), "holder_sha256": _hash(holder) if isinstance(holder, dict) and holder else None,
            "tool_json": raw}


def _approved_tool_library(profile):
    _fields(profile, ("source_path", "sha256"), label="tool_library")
    path = _approved_file(profile["source_path"], profile["sha256"], (".json",))
    if path.stat().st_size > 16 * 1024 * 1024:
        _fail("LIMIT_EXCEEDED", "Approved tool-library JSON exceeds the reviewed 16 MiB bound")
    descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("UNSAFE_PATH", "The tool library must remain a regular non-hardlinked file")
        data = source.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != profile["sha256"]:
        _fail("PROFILE_CHANGED", "Approved tool-library bytes changed before parsing")
    library = _namespace("cam").ToolLibrary.createFromJson(data.decode("utf-8-sig"))
    if library is None:
        _fail("INVALID_TOOL_LIBRARY", "Fusion rejected the approved tool library JSON")
    definitions = {}
    for tool in _items(library, 10000):
        definition = _tool_definition(tool)
        definitions.setdefault(definition["definition_sha256"], (tool, definition))
    if not definitions:
        _fail("INVALID_TOOL_LIBRARY", "The approved tool library contains no tools")
    return library, path, definitions


@_operation("cam.tools_list", ("tool_library",), ("limit", "offset", "tool_sha256"), read=True)
def _cam_tools_list(ctx):
    ctx.require_cam()
    library, path, definitions = _approved_tool_library(ctx.args["tool_library"])
    limit = _integer(ctx.args.get("limit", 50), "limit", 1, 100)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, 10000)
    entries = list(definitions.items())
    if "tool_sha256" in ctx.args:
        digest = _text(ctx.args["tool_sha256"], "tool_sha256", 64)
        if digest not in definitions:
            _fail("TOOL_NOT_FOUND", "The exact requested tool definition hash is not in the approved library")
        entries = [(digest, definitions[digest])]
        offset = 0
    rows = []
    for digest, (tool, definition) in entries[offset:offset + limit]:
        row = {"definition_sha256": digest, "holder_sha256": definition["holder_sha256"], "summary": []}
        for name in ("tool_type", "tool_number", "tool_diameter", "tool_fluteLength", "tool_shoulderLength", "tool_overallLength"):
            parameter = tool.parameters.itemByName(name)
            if parameter is not None:
                row["summary"].append(_cam_parameter_observation(parameter))
        if "tool_sha256" in ctx.args:
            row["tool_json"] = definition["tool_json"]
        rows.append(row)
    return {"tools": rows, "total_tools": library.count, "distinct_definitions": len(definitions),
            "next_offset": offset + limit if offset + limit < len(entries) else None,
            "source_path": str(path), "library_sha256": ctx.args["tool_library"]["sha256"],
            "units": "Autodesk CAM internal units; physical lengths are cm in numeric parameter summaries",
            "shared_library_modified": False, "selection": "Use the exact definition_sha256 to retrieve one complete tool_json"}


@_operation("cam.machining_time", ("operation_ids", "feed_scale_percent", "rapid_feed_cm_per_second", "tool_change_seconds"), read=True)
def _cam_machining_time(ctx):
    cam = ctx.require_cam()
    operations = _cutting_operations(ctx, ctx.args["operation_ids"])
    if any(not op.hasToolpath or not op.isToolpathValid for op in operations):
        _fail("INVALID_TOOLPATH", "Machining-time estimates require current generated cutting toolpaths")
    feed_scale = _number(ctx.args["feed_scale_percent"], "feed_scale_percent")
    rapid_feed = _number(ctx.args["rapid_feed_cm_per_second"], "rapid_feed_cm_per_second")
    tool_change = _number(ctx.args["tool_change_seconds"], "tool_change_seconds")
    if not 0 < feed_scale <= 1000 or not 0 < rapid_feed <= 100000 or not 0 <= tool_change <= 3600:
        _fail("INVALID_ARGUMENT", "Machining-time assumptions exceed the reviewed percent, cm/s, or seconds bounds")
    estimate = cam.getMachiningTime(_object_collection(operations), feed_scale, rapid_feed, tool_change)
    if estimate is None:
        _fail("API_REJECTED", "Fusion could not estimate the selected operations")
    return {"estimated": True, "machining_time": {"value": estimate.machiningTime, "unit": "s"},
            "feed_time": {"value": estimate.totalFeedTime, "unit": "s"},
            "rapid_time": {"value": estimate.totalRapidTime, "unit": "s"},
            "tool_change_time": {"value": estimate.totalToolChangeTime, "unit": "s"},
            "feed_distance": {"value": estimate.feedDistance, "unit": "cm"},
            "rapid_distance": {"value": estimate.rapidDistance, "unit": "cm"},
            "tool_change_count": estimate.toolChangeCount,
            "assumptions": {"feed_scale_percent": feed_scale, "rapid_feed_cm_per_second": rapid_feed, "tool_change_seconds": tool_change},
            "limits": "Estimate excludes unmodeled machine dynamics, operator handling, prove-out and actual controller behavior; not a guaranteed production cycle time"}


def _artifact_tree(folder):
    pending, artifacts = [(folder, 0)], []
    entries_seen, bytes_seen = 0, 0
    while pending:
        directory, depth = pending.pop()
        if depth > 8:
            _fail("LIMIT_EXCEEDED", "Setup-sheet artifact nesting exceeds the reviewed bound", outcome="partial")
        for path in directory.iterdir():
            entries_seen += 1
            if entries_seen > 500:
                _fail("LIMIT_EXCEEDED", "Too many setup-sheet artifacts", outcome="partial")
            _path(str(path), existing=not path.is_dir(), directory=path.is_dir())
            if path.is_dir():
                pending.append((path, depth + 1))
            else:
                bytes_seen += path.stat().st_size
                if bytes_seen > _MAX_FILE_BYTES:
                    _fail("LIMIT_EXCEEDED", "Setup-sheet artifacts exceed the reviewed aggregate size bound", outcome="partial")
                artifacts.append(_artifact(path, "html" if path.suffix.lower() in (".html", ".htm") else "setup_sheet_auxiliary"))
    if not any(artifact["format"] == "html" for artifact in artifacts):
        _fail("SETUP_SHEET_MISSING", "Autodesk did not produce an HTML setup sheet", outcome="partial")
    return artifacts


def _setup_sheet_status(ctx):
    job_id, job = _get_job(ctx, "setup_sheet")
    if _optional(ctx.app, "hasActiveJobs") is not False:
        return {"job_id": job_id, "status": "validating", "cancel_supported": False}
    current, gaps = _state(ctx)
    if gaps or current != job["candidate_state"]:
        _fail("SETUP_SHEET_SOURCE_CHANGED", "Source state changed while setup-sheet generation was pending", outcome="unknown")
    return {"job_id": job_id, "status": "succeeded", "artifacts": _artifact_tree(Path(job["folder"])),
            "cancel_supported": False, "physical_release": False, "approval": "Not a manufacturing signoff"}


@_operation("cam.setup_sheet", ("operation_ids", "format", "output_folder"))
def _cam_setup_sheet(ctx):
    cam = ctx.require_cam()
    _enum(ctx.args["format"], ("html",), "format")
    operations = _cutting_operations(ctx, ctx.args["operation_ids"])
    if any(not op.hasToolpath or not op.isToolpathValid for op in operations):
        _fail("INVALID_TOOLPATH", "Setup sheets require the authorized current cutting toolpaths")
    folder = _path(ctx.args["output_folder"], directory=True)
    if any(folder.iterdir()):
        _fail("OUTPUT_EXISTS", "Setup-sheet output requires a new empty private directory")
    if len(_JOBS) >= _MAX_JOBS:
        _fail("LIMIT_EXCEEDED", "Too many tracked session jobs")
    ctx.before(editable=False)
    _path(str(folder), directory=True)
    if any(folder.iterdir()):
        _fail("OUTPUT_EXISTS", "Setup-sheet destination changed before generation")
    ctx.call(cam.generateSetupSheet, _object_collection(operations), _namespace("cam").SetupSheetFormats.HTMLFormat, str(folder), False)
    ctx.effect("Generated HTML setup sheets for exact authorized operations without opening a browser or spreadsheet application")
    result = {"status": "succeeded", "format": "html", "source_state": ctx.request["expected_state"],
              "physical_release": False, "approval": "Setup documentation is not manufacturing signoff", "cancel_supported": False}
    if _optional(ctx.app, "hasActiveJobs") is not False:
        candidate_state, gaps = _state(ctx)
        if gaps:
            _fail("FRESHNESS_UNAVAILABLE", "Setup-sheet source state could not be established after submission", outcome="partial")
        result["job_id"] = _register_job(ctx, "setup_sheet", cam, folder=str(folder), candidate_state=candidate_state)
        result["status"] = "validating"
    else:
        result["artifacts"] = _artifact_tree(folder)
    return result


@_operation("bom.inspect", optional=("limit", "offset", "include_suppressed"), read=True)
def _bom_inspect(ctx):
    design = ctx.require_design()
    limit = _integer(ctx.args.get("limit", 100), "limit", 1, _MAX_RESULT)
    offset = _integer(ctx.args.get("offset", 0), "offset", 0, _MAX_SCAN)
    include_suppressed = _boolean(ctx.args.get("include_suppressed", False), "include_suppressed")
    root = design.rootComponent
    budget = _Budget()
    queue = deque((occ, None, 0) for occ in budget.items(root.occurrences))
    rows = []
    while queue:
        occurrence, parent_id, depth = queue.popleft()
        if depth > 64:
            _fail("LIMIT_EXCEEDED", "Assembly nesting exceeds the reviewed BOM traversal depth")
        handle = _register(ctx, occurrence, "occurrence")
        # Visibility is not suppression or BOM exclusion. Unqualified member
        # mappings remain null instead of guessing from a hidden light bulb.
        suppressed = None
        component = occurrence.component
        row = {"occurrence_id": handle, "parent_occurrence_id": parent_id, "depth": depth,
               "occurrence_path": occurrence.fullPathName,
               "component_id": _register(ctx, component, "component"), "component_vendor_id": component.id,
               "part_number": {"value": component.partNumber, "source": "Component.partNumber"},
               "description": {"value": component.description, "source": "Component.description"},
               "name": component.name, "quantity": {"value": 1, "unit": "each", "source": "One explicit occurrence instance"},
               "bom_quantity_override": None, "bom_exclusion": None, "suppressed": suppressed,
               "is_visible": _optional(occurrence, "isVisible"),
               "is_referenced": occurrence.isReferencedComponent,
               "transform": {"matrix": list(occurrence.transform2.asArray()), "translation_unit": "cm", "frame": "parent", "layout": "row_major"},
               "configuration_row_id": _optional(_optional(occurrence, "configurationRow"), "id"),
               "source_document_id": ctx.document_id}
        if occurrence.isReferencedComponent:
            row["external_source"] = _reference_identity(occurrence)
        material = component.material
        row["material"] = {"id": material.id, "name": material.name, "source": "Component.material"} if material else None
        if include_suppressed or suppressed is not True:
            rows.append((row, component))
        queue.extend((child, handle, depth + 1) for child in budget.items(occurrence.childOccurrences))
    output = []
    for row, component in rows[offset:offset + limit]:
        properties = component.getPhysicalProperties(_api().fusion.CalculationAccuracy.HighCalculationAccuracy)
        row["physical_properties"] = ({"mass": {"value": properties.mass, "unit": "kg"},
                                        "volume": {"value": properties.volume, "unit": "cm^3"},
                                        "source": "Component.getPhysicalProperties(HighCalculationAccuracy)",
                                        "scope": "Component definition, potentially including children; do not sum ancestor and descendant masses"}
                                       if properties is not None else None)
        output.append(row)
    cloud = _cloud_identity(ctx.doc)
    return {"observation_type": "desktop_occurrence_structure", "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": _SESSION, "document_id": ctx.document_id, "cloud": cloud, "configuration": _configuration(design),
            "composition": "Current unsaved desktop occurrence hierarchy", "rows": output, "total_occurrences": len(rows),
            "next_offset": offset + limit if offset + limit < len(rows) else None,
            "complete": offset == 0 and len(output) == len(rows), "normalization_complete": False,
            "unknown_fields": ["tenant authority", "suppression API mapping", "BOM exclusion", "BOM quantity overrides", "PLM release/revision"],
            "include_suppressed": include_suppressed,
            "caution": "Occurrence count is not an authoritative enterprise BOM. Unknown suppression is included; visibility does not determine exclusion."}


SOURCE_MEMBERS = {
    "documents.list": "Documents", "documents.create": "Documents_add", "documents.open": "Documents_open",
    "documents.activate": "Document_activate", "documents.close": "Document_close", "documents.save": "Document_saveAs",
    "document.inspect": "Design", "parameters.list": "Design_allParameters", "parameters.set": "Design_modifyParameters",
    "parameters.add": "UserParameters_add", "entities.find": "Design_findEntityByToken", "geometry.measure": "MeasureManager",
    "geometry.check": "Design_analyzeInterference", "sketches.create": "Sketches_add", "sketches.draw": "SketchLines_addTwoPointRectangle",
    "sketches.dimension": "SketchDimensions_addDistanceDimension", "features.extrude": "ExtrudeFeatureInput_setOneSideExtent",
    "features.revolve": "RevolveFeatureInput_setAngleExtent", "features.hole": "HoleFeatureInput_setPositionByPoint",
    "features.fillet": "FilletEdgeSetInputs_addConstantRadiusEdgeSet", "features.chamfer": "ChamferFeatures_createInput2",
    "features.shell": "ShellFeatures_createInput", "features.combine": "CombineFeatures_createInput", "features.pattern": "CircularPatternFeatures_createInput",
    "components.create": "Occurrences_addNewComponent", "components.insert": "Occurrences_addByInsert", "components.transform": "Occurrence_transform2",
    "joints.create": "AsBuiltJoints_createInput", "configurations.list": "ConfigurationTopTable", "configurations.activate": "ConfigurationRow_activate",
    "materials.list": "MaterialLibraries", "materials.assign": "BRepBody_material", "exports.generate": "ExportManager",
    "drawings.export_pdf": "DrawingExportManager_createPDFExportOptions", "view.capture": "Viewport_saveAsImageFile",
    "render.start": "Rendering_startLocalRender", "render.status": "RenderFuture", "cam.inspect": "CAM",
    "cam.setup_schema": "Setups_createInput", "cam.operation_schema": "Operations_createInput", "cam.setup_create": "Setups_createInput",
    "cam.operation_create": "Operations_createInput", "cam.template_apply": "Setup_createFromCAMTemplate2",
    "cam.generate": "CAM_generateToolpath", "cam.status": "GenerateToolpathFuture", "cam.nc_post": "NCProgram_postProcess",
    "flatpattern.create": "Component_createFlatPattern", "flatpattern.export": "ExportManager_createDXFFlatPatternExportOptions",
    "bom.inspect": "Occurrence_childOccurrences",
    "documents.import": "ImportManager_importToNewDocument", "sketches.constrain": "GeometricConstraints",
    "cam.tools_list": "ToolLibrary_createFromJson", "cam.machining_time": "CAM_getMachiningTime",
    "cam.setup_sheet": "CAM_generateSetupSheet",
}
