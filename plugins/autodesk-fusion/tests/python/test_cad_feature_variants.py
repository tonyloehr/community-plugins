"""Released-API contract tests for bounded CAD feature variants.

These are synthetic API doubles, not a Fusion geometry kernel. Their signatures
and writable members deliberately exclude unrelated, retired, or invented APIs.
The simulated adds change document bookkeeping so freshness/failure tests do not
mistake a recorded method call for an observed effect. No live provider is used.
"""

import json
import math
from types import SimpleNamespace as NS
import unittest

import test_fusion_runtime as base


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class TrackedInput:
    __slots__ = ("writes", "_participant_readback")

    def __init__(self):
        object.__setattr__(self, "writes", [])
        object.__setattr__(self, "_participant_readback", None)

    def __setattr__(self, name, value):
        if name == "participantBodies" and self._participant_readback is not None:
            value = self._participant_readback(value)
        object.__setattr__(self, name, value)
        self.writes.append(name)

    @property
    def isValid(self):
        return True


class OffsetInput(TrackedInput):
    __slots__ = ("support", "offset", "accepted")

    def __init__(self, accepted=True):
        super().__init__()
        self.support = self.offset = None
        self.accepted = accepted

    def setByOffset(self, planar_entity, offset):
        require(planar_entity.objectType in ("adsk::fusion::ConstructionPlane", "adsk::fusion::BRepFace"),
                "setByOffset requires a planar model entity")
        require(hasattr(offset, "expression"), "offset must retain its unit-aware ValueInput expression")
        self.support, self.offset = planar_entity, offset
        return self.accepted


class SweepInput(TrackedInput):
    __slots__ = ("profile", "path", "operation", "participantBodies", "isSolid", "orientation",
                 "distanceOne", "distanceTwo", "twistAngle", "taperAngle")

    def __init__(self, profile, path, operation):
        super().__init__()
        self.profile, self.path, self.operation = profile, path, operation
        self.participantBodies = None
        for field in ("isSolid", "orientation", "distanceOne", "distanceTwo", "twistAngle", "taperAngle"):
            object.__setattr__(self, field, None)


class LoftSections:
    __slots__ = ("items", "reject_index")

    def __init__(self):
        self.items = []
        self.reject_index = None

    def add(self, section):
        require(section.objectType == "adsk::fusion::Profile", "loft section must be one Profile")
        self.items.append(section)
        if len(self.items) == self.reject_index:
            return None
        # The documented add default is Free; the bounded variant must not use
        # undocumented end-condition setters or add guides/rails afterwards.
        return base.Object("adsk::fusion::LoftSection")


class LoftInput(TrackedInput):
    __slots__ = ("operation", "participantBodies", "isSolid", "isClosed", "loftSections")

    def __init__(self, operation):
        super().__init__()
        self.operation = operation
        self.participantBodies = None
        object.__setattr__(self, "isSolid", None)
        object.__setattr__(self, "isClosed", None)
        self.loftSections = LoftSections()


class DraftInput(TrackedInput):
    __slots__ = ("inputFaces", "plane", "isTangentChain", "isDirectionFlipped", "single_angle_calls", "accepted")

    def __init__(self, faces, plane, tangent_chain):
        super().__init__()
        self.inputFaces, self.plane, self.isTangentChain = faces, plane, tangent_chain
        object.__setattr__(self, "isDirectionFlipped", False)
        self.single_angle_calls = []
        self.accepted = True

    def setSingleAngle(self, is_symmetric, angle):
        require(type(is_symmetric) is bool, "single-angle symmetry is a boolean")
        require(hasattr(angle, "expression"), "draft angle must be a unit-aware ValueInput")
        self.single_angle_calls.append((is_symmetric, angle))
        return self.accepted


class SplitInput(TrackedInput):
    __slots__ = ("splitBodies", "splittingTool", "isSplittingToolExtended")

    def __init__(self, bodies, tool, extend):
        super().__init__()
        self.splitBodies, self.splittingTool, self.isSplittingToolExtended = bodies, tool, extend


class MirrorInput(TrackedInput):
    __slots__ = ("inputEntities", "mirrorPlane", "isCombine")

    def __init__(self, bodies, plane):
        super().__init__()
        self.inputEntities, self.mirrorPlane = bodies, plane
        object.__setattr__(self, "isCombine", False)


class NamedResult(base.Object):
    def __setattr__(self, name, value):
        if name == "name" and getattr(self, "reject_name", False):
            raise RuntimeError("Synthetic property failure after a committed add")
        super().__setattr__(name, value)


def advance_timeline(component, entity):
    timeline = component.parentDesign.timeline
    timeline.items.append(base.Object("adsk::fusion::TimelineObject", entity=entity))
    timeline.markerPosition = timeline.count


class FeatureSink:
    input_type = None
    feature_name = None

    def __init__(self, component):
        self.component = component
        self.inputs, self.create_calls = [], []
        self.last_input = None
        self.add_calls = 0
        self.null_input = False
        self.configure_input = None
        self.add_mode = None
        self.body_result_mode = None

    def capture(self, input_obj, args):
        self.create_calls.append(args)
        if self.null_input:
            return None
        self.last_input = input_obj
        if self.configure_input:
            self.configure_input(input_obj)
        return input_obj

    def add(self, input_obj):
        require(type(input_obj) is self.input_type and input_obj is self.last_input,
                "add must consume the prepared input for this collection")
        self.add_calls += 1
        if self.add_mode == "raise_before_effect":
            raise RuntimeError("Synthetic add rejection with uncertain native outcome")
        self.inputs.append(input_obj)
        affected = self.apply_bookkeeping(input_obj)
        if self.body_result_mode == "empty":
            affected = []
        elif self.body_result_mode == "empty_removed":
            for body in input_obj.participantBodies:
                self.component.bRepBodies.items.remove(body)
                body.isValid = False
            affected = []
        elif self.body_result_mode == "non_solid_last":
            affected[-1].isSolid = False
        elif self.body_result_mode == "temporary_last":
            affected[-1].isTemporary = True
        elif self.body_result_mode == "proxy_last":
            affected[-1].assemblyContext = base.Occurrence(self.component)
        elif self.body_result_mode == "foreign_last":
            affected[-1].parentComponent = base.Component(self.component.parentDesign, "wrong-output-component")
        feature = NamedResult("adsk::fusion::" + self.feature_name + "Feature", parentComponent=self.component,
                              name="Synthetic feature", healthState=0, errorOrWarningMessage="",
                              bodies=None if self.body_result_mode == "unavailable" else base.Collection(affected))
        self.component.features.items.append(feature)
        advance_timeline(self.component, feature)
        if self.add_mode == "null_after_effect":
            return None
        if self.add_mode == "raise_after_effect":
            raise RuntimeError("Synthetic add threw after modifying the document")
        feature.reject_name = self.add_mode == "name_failure"
        return feature

    def apply_bookkeeping(self, inp):
        # Only observable bookkeeping is simulated; no geometry validity claim.
        if isinstance(inp, DraftInput):
            affected = [inp.inputFaces[0].body]
        elif isinstance(inp, SplitInput):
            affected = list(inp.splitBodies.items) if isinstance(inp.splitBodies, base.Collection) else [inp.splitBodies]
            copies = [base.Body(self.component, "Synthetic split result") for _ in affected]
            self.component.bRepBodies.items.extend(copies)
        elif isinstance(inp, MirrorInput):
            copies = [base.Body(self.component, "Synthetic mirrored result") for _ in inp.inputEntities.items]
            self.component.bRepBodies.items.extend(copies)
            return copies
        elif inp.operation == 0:
            body = base.Body(self.component, "Synthetic new body")
            self.component.bRepBodies.items.append(body)
            return [body]
        else:
            affected = inp.participantBodies or list(self.component.bRepBodies.items)
        for body in affected:
            body.revisionId += "-edited"
        return affected + (copies if isinstance(inp, SplitInput) else [])


class SweepFeatures(FeatureSink):
    input_type, feature_name = SweepInput, "Sweep"

    def createInput(self, profile, path, operation):
        require(profile.objectType == "adsk::fusion::Profile", "sweep profile is not an ObjectCollection")
        require(type(path) is Path, "sweep input requires the constructed Path")
        return self.capture(SweepInput(profile, path, operation), (profile, path, operation))


class LoftFeatures(FeatureSink):
    input_type, feature_name = LoftInput, "Loft"

    def createInput(self, operation):
        return self.capture(LoftInput(operation), (operation,))


class DraftFeatures(FeatureSink):
    input_type, feature_name = DraftInput, "Draft"

    def createInput(self, input_faces, plane, is_tangent_chain=True):
        require(type(input_faces) is list, "DraftFeatures expects a BRepFace array, not ObjectCollection")
        require(all(face.objectType == "adsk::fusion::BRepFace" for face in input_faces), "draft only takes faces")
        require(type(is_tangent_chain) is bool, "tangent chain must be boolean")
        return self.capture(DraftInput(input_faces, plane, is_tangent_chain), (input_faces, plane, is_tangent_chain))


class SplitFeatures(FeatureSink):
    input_type, feature_name = SplitInput, "SplitBody"

    def createInput(self, split_bodies, splitting_tool, is_splitting_tool_extended):
        require(isinstance(split_bodies, base.Body) or type(split_bodies) is base.Collection,
                "split targets must be one BRepBody or an ObjectCollection")
        require(type(is_splitting_tool_extended) is bool, "tool extension must be explicit boolean")
        return self.capture(SplitInput(split_bodies, splitting_tool, is_splitting_tool_extended),
                            (split_bodies, splitting_tool, is_splitting_tool_extended))


class MirrorFeatures(FeatureSink):
    input_type, feature_name = MirrorInput, "Mirror"

    def createInput(self, input_entities, mirror_plane):
        require(type(input_entities) is base.Collection, "mirror always requires an ObjectCollection")
        require(all(entity.objectType == "adsk::fusion::BRepBody" for entity in input_entities.items),
                "bounded mirror collection contains only bodies")
        return self.capture(MirrorInput(input_entities, mirror_plane), (input_entities, mirror_plane))


class OffsetPlanes(base.Collection):
    def __init__(self, component):
        super().__init__()
        self.component = component
        self.create_calls, self.inputs = [], []
        self.add_calls = 0
        self.null_input = False
        self.configure_input = None
        self.add_mode = None
        self.last_input = None

    def createInput(self):
        self.create_calls.append(())
        if self.null_input:
            return None
        self.last_input = OffsetInput()
        if self.configure_input:
            self.configure_input(self.last_input)
        return self.last_input

    def add(self, input_obj):
        require(type(input_obj) is OffsetInput and input_obj is self.last_input, "offset add requires its prepared input")
        self.add_calls += 1
        if self.add_mode == "raise_before_effect":
            raise RuntimeError("Synthetic plane add rejection")
        self.inputs.append(input_obj)
        support = input_obj.support.geometry
        distance = self.component.parentDesign.unitsManager.evaluateExpression(input_obj.offset.expression, "cm")
        normal = support.normal
        scale = math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2)
        origin = base.Point(support.origin.x + distance * normal.x / scale,
                            support.origin.y + distance * normal.y / scale,
                            support.origin.z + distance * normal.z / scale)
        plane = NamedResult("adsk::fusion::ConstructionPlane", component=self.component, name="Synthetic offset",
                            healthState=0, errorOrWarningMessage="",
                            geometry=base.Object("adsk::core::Plane", origin=origin,
                                                 normal=base.Point(normal.x, normal.y, normal.z)))
        self.items.append(plane)
        advance_timeline(self.component, plane)
        if self.add_mode == "null_after_effect":
            return None
        if self.add_mode == "raise_after_effect":
            raise RuntimeError("Synthetic plane add threw after creating a plane")
        plane.reject_name = self.add_mode == "name_failure"
        return plane


class Path:
    __slots__ = ("_entities", "isValid", "isClosed")

    def __init__(self, entities, valid=True, closed=False):
        self._entities = list(entities)
        self.isValid, self.isClosed = valid, closed

    @property
    def count(self):
        return len(self._entities)

    def item(self, index):
        return base.Object("adsk::fusion::PathEntity", entity=self._entities[index])


class PathFactory:
    def __init__(self, no_chaining):
        self.no_chaining = no_chaining
        self.calls = []
        self.mode = "normal"
        self.substitute = None

    def create(self, curves, chain_option):
        require(type(curves) is base.Collection, "Path.create requires the explicit ObjectCollection")
        require(chain_option is self.no_chaining, "automatic curve chaining is forbidden")
        self.calls.append((list(curves.items), chain_option))
        entities = list(curves.items)
        if self.mode == "null":
            return None
        if self.mode == "extra":
            entities.append(self.substitute)
        elif self.mode == "missing":
            entities.pop()
        elif self.mode == "duplicate":
            entities[-1] = entities[0]
        elif self.mode == "replacement":
            entities[-1] = self.substitute
        elif self.mode == "reverse":
            entities.reverse()
        return Path(entities, valid=self.mode != "invalid", closed=self.mode == "closed")


OPERATIONS = ("construction_planes.offset", "features.sweep", "features.loft", "features.draft",
              "features.split_body", "features.mirror")


class CadFeatureContracts(unittest.TestCase):
    # Reuse setup helpers without inheriting and rerunning the older test suite.
    tearDown = base.RuntimeContracts.tearDown
    handle = base.RuntimeContracts.handle
    state = base.RuntimeContracts.state
    call = base.RuntimeContracts.call
    assert_error = base.RuntimeContracts.assert_error

    def setUp(self):
        base.RuntimeContracts.setUp(self)
        self.component = self.env.design.rootComponent
        self.component.constructionPlanes = OffsetPlanes(self.component)
        for member, factory in (("sweepFeatures", SweepFeatures), ("loftFeatures", LoftFeatures),
                                ("draftFeatures", DraftFeatures), ("splitBodyFeatures", SplitFeatures),
                                ("mirrorFeatures", MirrorFeatures)):
            setattr(self.component.features, member, factory(self.component))
        self.no_chaining = object()
        self.perpendicular = object()
        self.paths = PathFactory(self.no_chaining)
        self.env.api.fusion.ChainedCurveOptions = NS(noChainedCurves=self.no_chaining)
        self.env.api.fusion.SweepOrientationTypes = NS(PerpendicularOrientationType=self.perpendicular)
        self.env.api.fusion.Path = NS(create=self.paths.create)

    def body(self, component=None, solid=True, temporary=False):
        component = component or self.component
        body = base.Body(component, "Body " + str(component.bRepBodies.count + 1))
        body.isSolid, body.isTemporary = solid, temporary
        component.bRepBodies.items.append(body)
        return body

    def face(self, body=None):
        body = body or self.body()
        token = "cad-face-" + str(len(self.env.design.tokens))
        face = base.Face(body, token)
        face.pointOnFace = base.Point(0.5, 0.5, 0)
        body.faces.items.append(face)
        self.env.design.tokens[token] = [face]
        return face

    def profile(self, component=None, sketch=None):
        sketch = sketch or (component or self.component).add_sketch(None)
        profile = base.Object("adsk::fusion::Profile", parentSketch=sketch)
        sketch.profiles.items.append(profile)
        return profile

    def line(self, sketch=None, start=None, end=None):
        sketch = sketch or self.component.add_sketch(None)
        start, end = start or base.Point(), end or base.Point(1, 0, 0)
        line = sketch.sketchCurves.addByTwoPoints(start, end)
        line.geometry = base.Object("adsk::core::Line3D", startPoint=start, endPoint=end)
        return line

    def child_component(self):
        component = base.Component(self.env.design, "child-" + str(self.env.design.allComponents.count))
        self.env.design.allComponents.items.append(component)
        return component

    def custom_construction(self, kind):
        if kind == "plane":
            obj = base.Object("adsk::fusion::ConstructionPlane", component=self.component, name="Custom plane",
                              geometry=base.Object("adsk::core::Plane", origin=base.Point(1, 2, 3), normal=base.Point(0, 0, 1)))
            self.component.constructionPlanes.items.append(obj)
        else:
            obj = base.Object("adsk::fusion::ConstructionAxis", component=self.component, name="Custom axis",
                              geometry=base.Object("adsk::core::InfiniteLine3D", origin=base.Point(1, 2, 3), direction=base.Point(1, 0, 0)))
            self.component.constructionAxes.items.append(obj)
        return obj

    def scenario(self, operation):
        plane = self.component.xYConstructionPlane
        selected = {"plane": plane}
        if operation == "construction_planes.offset":
            return {"plane_id": self.handle(plane), "distance": "-2 cm"}, self.component.constructionPlanes, selected
        if operation == "features.sweep":
            profile = self.profile()
            line = self.line()
            second = self.line(line.parentSketch, base.Point(1, 0, 0), base.Point(2, 1, 0))
            selected.update(profile=profile, path=[line, second])
            args = {"profile_id": self.handle(profile), "path_entity_ids": [self.handle(line), self.handle(second)], "operation": "new_body"}
            return args, self.component.features.sweepFeatures, selected
        if operation == "features.loft":
            profiles = [self.profile(), self.profile()]
            selected["profiles"] = profiles
            return {"profile_ids": [self.handle(p) for p in profiles], "operation": "new_body"}, self.component.features.loftFeatures, selected
        body = self.body()
        selected["body"] = body
        if operation == "features.draft":
            faces = [self.face(body), self.face(body)]
            selected["faces"] = faces
            return {"face_ids": [self.handle(f) for f in faces], "plane_id": self.handle(plane), "angle": "-3 deg"}, self.component.features.draftFeatures, selected
        if operation == "features.split_body":
            return {"body_ids": [self.handle(body)], "splitting_tool_id": self.handle(plane), "extend_tool": False}, self.component.features.splitBodyFeatures, selected
        return {"body_ids": [self.handle(body)], "plane_id": self.handle(plane)}, self.component.features.mirrorFeatures, selected

    def assert_no_add(self, result, collection, code=None):
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["outcome"], "none", result)
        if code:
            self.assertEqual(result["error"]["code"], code, result)
        self.assertEqual(getattr(collection, "add_calls", len(collection.inputs)), 0, result)
        self.assertEqual(self.env.design.timeline.count, 0, result)

    def reset_fixture(self):
        self.tearDown()
        self.setUp()

    def test_offset_preserves_signed_units_and_actual_plane_ownership(self):
        args, collection, selected = self.scenario("construction_planes.offset")
        self.assertFalse(hasattr(selected["plane"], "parentComponent"))
        before = self.state()
        result = self.call("construction_planes.offset", dict(args, name="Offset below"))
        self.assertTrue(result["ok"], result)
        self.assertIs(collection.last_input.support, selected["plane"])
        self.assertEqual(collection.last_input.offset.expression, "-2 cm")
        self.assertEqual(collection.add_calls, 1)
        self.assertEqual(collection.items[0].name, "Offset below")
        self.assertAlmostEqual(collection.items[0].geometry.origin.z, -2.0)
        self.assertNotEqual(result["state"], before)

    def test_offset_accepts_planar_face_and_native_child_component_plane(self):
        face = self.face()
        result = self.call("construction_planes.offset", {"plane_id": self.handle(face), "distance": "0.25 in"})
        self.assertTrue(result["ok"], result)
        self.assertIs(self.component.constructionPlanes.last_input.support, face)
        self.reset_fixture()
        child = self.child_component()
        child.constructionPlanes = OffsetPlanes(child)
        result = self.call("construction_planes.offset", {"plane_id": self.handle(child.xYConstructionPlane), "distance": "5 mm"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(child.constructionPlanes.add_calls, 1)
        self.assertEqual(self.component.constructionPlanes.add_calls, 0)

    def test_sweep_uses_exact_open_path_and_explicit_full_perpendicular_settings(self):
        args, collection, selected = self.scenario("features.sweep")
        before = self.state()
        result = self.call("features.sweep", args)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.paths.calls, [(selected["path"], self.no_chaining)])
        inp = collection.last_input
        self.assertIs(inp.profile, selected["profile"])
        self.assertEqual(inp.path.count, 2)
        self.assertIs(inp.orientation, self.perpendicular)
        self.assertIs(inp.isSolid, True)
        self.assertEqual((inp.distanceOne.value, inp.distanceTwo.value), (1.0, 1.0))
        self.assertEqual((inp.twistAngle.value, inp.taperAngle.value), (0.0, 0.0))
        self.assertIsNone(inp.participantBodies)
        self.assertNotEqual(result["state"], before)
        self.assertEqual(self.component.bRepBodies.count, 1)

    def test_sweep_accepts_exact_brep_edge_membership_and_api_path_reordering(self):
        args, collection, selected = self.scenario("features.sweep")
        body = self.body()
        edge = base.Object("adsk::fusion::BRepEdge", body=body,
                           geometry=base.Object("adsk::core::Line3D", startPoint=base.Point(1, 0, 0), endPoint=base.Point(2, 0, 0)))
        body.edges.items.append(edge)
        args["path_entity_ids"][-1] = self.handle(edge)
        self.paths.mode = "reverse"
        result = self.call("features.sweep", args)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.paths.calls[0][0], [selected["path"][0], edge])
        self.assertIs(collection.last_input.path.item(0).entity, edge)

    def test_loft_preserves_ordered_profiles_and_free_section_defaults(self):
        args, collection, selected = self.scenario("features.loft")
        third = self.profile()
        ordered = [third, selected["profiles"][0], selected["profiles"][1]]
        args["profile_ids"] = [self.handle(p) for p in ordered]
        before = self.state()
        result = self.call("features.loft", args)
        self.assertTrue(result["ok"], result)
        self.assertEqual(collection.create_calls, [(0,)])
        self.assertEqual(collection.last_input.loftSections.items, ordered)
        self.assertIs(collection.last_input.isSolid, True)
        self.assertIs(collection.last_input.isClosed, False)
        self.assertIsNone(collection.last_input.participantBodies)
        self.assertNotEqual(result["state"], before)

    def test_sweep_and_loft_modify_only_explicit_persistent_solid_participants(self):
        for operation in ("features.sweep", "features.loft"):
            for effect in ("cut", "intersect"):
                with self.subTest(operation=operation, effect=effect):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    target, untouched = self.body(), self.body()
                    previous = untouched.revisionId
                    args.update(operation=effect, participant_body_ids=[self.handle(target)])
                    result = self.call(operation, args)
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(collection.last_input.participantBodies, [target])
                    self.assertEqual(collection.last_input.operation, 2 if effect == "cut" else 3)
                    self.assertEqual(untouched.revisionId, previous)
                    self.assertTrue(target.revisionId.endswith("-edited"))

    def test_sweep_and_loft_reject_missing_participants_and_ambiguous_joins(self):
        for operation in ("features.sweep", "features.loft"):
            for effect in ("cut", "intersect", "join"):
                with self.subTest(operation=operation, effect=effect):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    self.body()
                    self.body()
                    args["operation"] = effect
                    result = self.call(operation, args)
                    self.assert_no_add(result, collection, "AMBIGUOUS_ENTITY" if effect == "join" else "PARTICIPANTS_REQUIRED")

    def test_participant_setter_readback_must_match_the_exact_selected_bodies(self):
        for operation in ("features.sweep", "features.loft"):
            for mode in ("null", "missing", "extra", "substituted", "duplicate"):
                with self.subTest(operation=operation, mode=mode):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    first, second, unselected = self.body(), self.body(), self.body()
                    args.update(operation="cut", participant_body_ids=[self.handle(first), self.handle(second)])
                    readbacks = {"null": lambda bodies: None,
                                 "missing": lambda bodies: bodies[:1],
                                 "extra": lambda bodies: [*bodies, unselected],
                                 "substituted": lambda bodies: [bodies[0], unselected],
                                 "duplicate": lambda bodies: [bodies[0], bodies[0]]}
                    collection.configure_input = lambda inp: setattr(inp, "_participant_readback", readbacks[mode])
                    before = self.state()
                    self.assert_no_add(self.call(operation, args), collection, "API_REJECTED")
                    self.assertEqual(self.state(), before)

    def test_reordered_exact_participant_readback_does_not_change_selected_scope(self):
        for operation in ("features.sweep", "features.loft"):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                first, second, unselected = self.body(), self.body(), self.body()
                original = unselected.revisionId
                args.update(operation="intersect", participant_body_ids=[self.handle(first), self.handle(second)])
                collection.configure_input = lambda inp: setattr(inp, "_participant_readback", lambda bodies: list(reversed(bodies)))
                result = self.call(operation, args)
                self.assertTrue(result["ok"], result)
                self.assertEqual(collection.last_input.participantBodies, [second, first])
                self.assertEqual(unselected.revisionId, original)

    def test_draft_uses_ordered_face_array_signed_angle_and_explicit_safe_defaults(self):
        args, collection, selected = self.scenario("features.draft")
        result = self.call("features.draft", args)
        self.assertTrue(result["ok"], result)
        inp = collection.last_input
        self.assertEqual(collection.create_calls, [(selected["faces"], selected["plane"], False)])
        self.assertEqual(len(inp.single_angle_calls), 1)
        symmetric, angle = inp.single_angle_calls[0]
        self.assertIs(symmetric, False)
        self.assertEqual(angle.expression, "-3 deg")
        self.assertIs(inp.isDirectionFlipped, False)
        self.assertIn("isDirectionFlipped", inp.writes)
        self.assertEqual(selected["body"].revisionId, "body-r1-edited")

    def test_draft_explicit_flags_and_face_order_are_preserved(self):
        args, collection, selected = self.scenario("features.draft")
        args.update(face_ids=list(reversed(args["face_ids"])), angle="0.1 rad", symmetric=True,
                    direction_flipped=True, tangent_chain=True)
        result = self.call("features.draft", args)
        self.assertTrue(result["ok"], result)
        inp = collection.last_input
        self.assertEqual(inp.inputFaces, list(reversed(selected["faces"])))
        self.assertIs(inp.isTangentChain, True)
        self.assertIs(inp.isDirectionFlipped, True)
        self.assertIs(inp.single_angle_calls[0][0], True)
        self.assertEqual(inp.single_angle_calls[0][1].expression, "0.1 rad")

    def test_split_uses_direct_single_target_or_collection_and_exact_supported_cutter(self):
        for count in (1, 2):
            for tool_kind in ("plane", "planar_face", "surface_body", "target_face"):
                with self.subTest(count=count, tool=tool_kind):
                    self.reset_fixture()
                    args, collection, selected = self.scenario("features.split_body")
                    targets = [selected["body"]] + ([self.body()] if count == 2 else [])
                    tool = selected["plane"]
                    if tool_kind == "planar_face":
                        tool = self.face()
                    elif tool_kind == "target_face":
                        # A face is a separately selected API entity, even on
                        # a target body. This only checks accepted selection;
                        # whether extension intersects is a real-kernel gate.
                        tool = self.face(targets[0])
                    elif tool_kind == "surface_body":
                        tool = self.body(solid=False)
                        self.face(tool)
                    extension = count == 2 or tool_kind == "target_face"
                    args.update(body_ids=[self.handle(b) for b in targets], splitting_tool_id=self.handle(tool),
                                extend_tool=extension)
                    result = self.call("features.split_body", args)
                    self.assertTrue(result["ok"], result)
                    native_targets, native_tool, extend = collection.create_calls[0]
                    if count == 1:
                        self.assertIs(native_targets, targets[0])
                    else:
                        self.assertIs(type(native_targets), base.Collection)
                        self.assertEqual(native_targets.items, targets)
                    self.assertIs(native_tool, tool)
                    self.assertIs(extend, extension)
                    self.assertEqual(collection.add_calls, 1)

    def test_mirror_always_uses_body_collection_and_explicitly_disables_combine(self):
        for count in (1, 2):
            with self.subTest(count=count):
                self.reset_fixture()
                args, collection, selected = self.scenario("features.mirror")
                bodies = [selected["body"]] + ([self.body()] if count == 2 else [])
                original_revisions = [b.revisionId for b in bodies]
                args["body_ids"] = [self.handle(b) for b in bodies]
                result = self.call("features.mirror", args)
                self.assertTrue(result["ok"], result)
                inp = collection.last_input
                self.assertEqual(inp.inputEntities.items, bodies)
                self.assertIs(inp.mirrorPlane, selected["plane"])
                self.assertIs(inp.isCombine, False)
                self.assertIn("isCombine", inp.writes)
                self.assertEqual([b.revisionId for b in bodies], original_revisions)
                self.assertEqual(self.component.bRepBodies.items[:count], bodies)
                self.assertEqual(self.component.bRepBodies.count, count * 2)

    def test_all_new_variants_require_parametric_mode_and_timeline_at_end(self):
        for operation in OPERATIONS:
            for condition in ("direct", "timeline"):
                with self.subTest(operation=operation, condition=condition):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    if condition == "direct":
                        self.env.design.designType = 0
                    else:
                        self.env.design.timeline.markerPosition = -1
                    result = self.call(operation, args)
                    self.assert_no_add(result, collection, "UNSUPPORTED_DESIGN_TYPE" if condition == "direct" else "TIMELINE_NOT_AT_END")
                    self.assertEqual(collection.create_calls, [])
                    self.assertEqual(self.env.design.designType, 0 if condition == "direct" else 1)

    def test_all_new_variants_reject_unknown_options_before_any_vendor_input(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                args["automatic_geometry_repair"] = True
                result = self.call(operation, args)
                self.assert_no_add(result, collection, "INVALID_ARGUMENT")
                self.assertEqual(collection.create_calls, [])

    def test_path_rejects_invalid_closed_or_changed_native_membership(self):
        for mode in ("null", "invalid", "closed", "missing", "extra", "duplicate", "replacement"):
            with self.subTest(mode=mode):
                self.reset_fixture()
                args, collection, _ = self.scenario("features.sweep")
                self.paths.mode = mode
                self.paths.substitute = self.line()
                result = self.call("features.sweep", args)
                self.assert_no_add(result, collection)
                self.assertEqual(collection.create_calls, [])

    def test_sweep_and_loft_require_computed_profile_membership(self):
        for operation in ("features.sweep", "features.loft"):
            for condition in ("uncomputed", "missing_compute_flag", "not_in_sketch"):
                with self.subTest(operation=operation, condition=condition):
                    self.reset_fixture()
                    args, collection, selected = self.scenario(operation)
                    profile = selected["profile"] if operation == "features.sweep" else selected["profiles"][0]
                    if condition == "uncomputed":
                        profile.parentSketch.isComputeDeferred = True
                    elif condition == "missing_compute_flag":
                        del profile.parentSketch.isComputeDeferred
                    else:
                        profile.parentSketch.profiles.items.remove(profile)
                    result = self.call(operation, args)
                    self.assert_no_add(result, collection)
                    self.assertEqual(collection.create_calls, [])

    def test_duplicate_entity_lists_never_reach_add(self):
        for operation, field in (("features.sweep", "path_entity_ids"), ("features.loft", "profile_ids"),
                                 ("features.draft", "face_ids"), ("features.split_body", "body_ids"),
                                 ("features.mirror", "body_ids")):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                args[field] = [args[field][0], args[field][0]]
                self.assert_no_add(self.call(operation, args), collection, "INVALID_ARGUMENT")

    def test_bounded_selection_counts_are_enforced_before_resolution(self):
        for operation, field, length in (("features.sweep", "path_entity_ids", 0),
                                         ("features.sweep", "path_entity_ids", 101),
                                         ("features.loft", "profile_ids", 1),
                                         ("features.loft", "profile_ids", 21),
                                         ("features.draft", "face_ids", 0),
                                         ("features.draft", "face_ids", 101),
                                         ("features.split_body", "body_ids", 0),
                                         ("features.split_body", "body_ids", 101),
                                         ("features.mirror", "body_ids", 0),
                                         ("features.mirror", "body_ids", 101)):
            with self.subTest(operation=operation, length=length):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                args[field] = ["unresolved-" + str(i) for i in range(length)]
                self.assert_no_add(self.call(operation, args), collection, "INVALID_ARGUMENT")
                self.assertEqual(collection.create_calls, [])

    def test_draft_rejects_zero_right_or_obtuse_angles_and_unitless_literals(self):
        for angle in ("0 deg", "90 deg", "-90 deg", "120 deg", "-120 deg", "3", "NaN deg", "1 mm"):
            with self.subTest(angle=angle):
                self.reset_fixture()
                args, collection, _ = self.scenario("features.draft")
                args["angle"] = angle
                self.assert_no_add(self.call("features.draft", args), collection)

    def test_boolean_controls_are_typed_and_split_extension_is_required(self):
        for operation, field in (("features.draft", "symmetric"), ("features.draft", "direction_flipped"),
                                 ("features.draft", "tangent_chain"), ("features.split_body", "extend_tool")):
            for value in (1, "false", None):
                with self.subTest(operation=operation, field=field, value=value):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    args[field] = value
                    self.assert_no_add(self.call(operation, args), collection, "INVALID_ARGUMENT")
        self.reset_fixture()
        args, collection, _ = self.scenario("features.split_body")
        del args["extend_tool"]
        self.assert_no_add(self.call("features.split_body", args), collection, "INVALID_ARGUMENT")
        self.assertEqual(collection.create_calls, [])

    def test_draft_rejects_faces_spanning_multiple_bodies(self):
        args, collection, _ = self.scenario("features.draft")
        args["face_ids"].append(self.handle(self.face()))
        self.assert_no_add(self.call("features.draft", args), collection)

    def test_targets_and_participants_must_be_persistent_solids(self):
        for operation in ("features.draft", "features.split_body", "features.mirror", "features.sweep", "features.loft"):
            for condition in ("temporary", "surface", "unknown_persistence"):
                with self.subTest(operation=operation, condition=condition):
                    self.reset_fixture()
                    args, collection, selected = self.scenario(operation)
                    target = selected.get("body") or self.body()
                    if operation in ("features.sweep", "features.loft"):
                        args.update(operation="cut", participant_body_ids=[self.handle(target)])
                    if condition == "temporary":
                        target.isTemporary = True
                    elif condition == "surface":
                        target.isSolid = False
                    else:
                        del target.isTemporary
                    self.assert_no_add(self.call(operation, args), collection)

    def test_split_rejects_target_alias_and_unsupported_cutter_types(self):
        for kind in ("target_body", "solid_body", "empty_surface", "temporary_surface", "profile", "axis", "curved_face"):
            with self.subTest(kind=kind):
                self.reset_fixture()
                args, collection, selected = self.scenario("features.split_body")
                if kind == "target_body":
                    tool = selected["body"]
                elif kind == "solid_body":
                    tool = self.body()
                elif kind in ("empty_surface", "temporary_surface"):
                    tool = self.body(solid=False, temporary=kind == "temporary_surface")
                    if kind == "temporary_surface":
                        self.face(tool)
                elif kind == "profile":
                    tool = self.profile()
                elif kind == "axis":
                    tool = self.component.zConstructionAxis
                else:
                    tool = self.face()
                    tool.geometry = base.Object("adsk::core::Cylinder")
                args["splitting_tool_id"] = self.handle(tool)
                self.assert_no_add(self.call("features.split_body", args), collection)

    def test_planes_reject_curved_faces_and_wrong_entity_types(self):
        for operation in ("construction_planes.offset", "features.draft", "features.mirror"):
            for kind in ("curved_face", "axis", "body"):
                with self.subTest(operation=operation, kind=kind):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    if kind == "curved_face":
                        plane = self.face()
                        plane.geometry = base.Object("adsk::core::Cylinder")
                    else:
                        plane = self.component.zConstructionAxis if kind == "axis" else self.body()
                    args["plane_id"] = self.handle(plane)
                    self.assert_no_add(self.call(operation, args), collection, "WRONG_ENTITY_TYPE")

    def test_new_variants_reject_proxy_selections(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, selected = self.scenario(operation)
                if operation == "features.sweep":
                    obj, field = selected["profile"], "profile_id"
                elif operation == "features.loft":
                    obj, field = selected["profiles"][0], "profile_ids"
                elif operation == "features.draft":
                    obj, field = selected["faces"][0], "face_ids"
                elif operation in ("features.split_body", "features.mirror"):
                    obj, field = selected["body"], "body_ids"
                else:
                    obj, field = selected["plane"], "plane_id"
                prior_handle = args[field][0] if isinstance(args[field], list) else args[field]
                self.runtime._ENTITIES.pop(prior_handle)
                obj.assemblyContext = base.Occurrence(self.component)
                # Inspect a proxy as a proxy; changing context after inspection
                # would only exercise generic stale-selection detection.
                if isinstance(args[field], list):
                    args[field][0] = self.handle(obj)
                else:
                    args[field] = self.handle(obj)
                result = self.call(operation, args)
                self.assert_no_add(result, collection, "UNSUPPORTED_CONTEXT")

    def test_new_variants_reject_foreign_or_mixed_component_context(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, selected = self.scenario(operation)
                child = self.child_component()
                if operation == "construction_planes.offset":
                    foreign = base.Design().rootComponent
                    args["plane_id"] = self.handle(foreign.xYConstructionPlane)
                elif operation == "features.sweep":
                    args["path_entity_ids"][0] = self.handle(self.line(child.add_sketch(None)))
                elif operation == "features.loft":
                    args["profile_ids"][1] = self.handle(self.profile(child))
                elif operation == "features.split_body":
                    args["splitting_tool_id"] = self.handle(child.xYConstructionPlane)
                else:
                    args["plane_id"] = self.handle(child.xYConstructionPlane)
                self.assert_no_add(self.call(operation, args), collection)

    def test_all_input_creation_nulls_have_no_effect(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                before = self.state()
                collection.null_input = True
                self.assert_no_add(self.call(operation, args), collection, "API_REJECTED")
                self.assertEqual(self.state(), before)

    def test_false_input_configuration_and_null_loft_section_never_add(self):
        for operation in ("construction_planes.offset", "features.draft", "features.loft"):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                if operation == "features.loft":
                    collection.configure_input = lambda inp: setattr(inp.loftSections, "reject_index", 2)
                else:
                    collection.configure_input = lambda inp: setattr(inp, "accepted", False)
                before = self.state()
                self.assert_no_add(self.call(operation, args), collection, "API_REJECTED")
                self.assertEqual(self.state(), before)

    def test_native_input_preparation_exception_is_not_reported_as_a_model_edit(self):
        def reject_input(_):
            raise RuntimeError("Synthetic native input preparation failure")

        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                before = self.state()
                collection.configure_input = reject_input
                self.assert_no_add(self.call(operation, args), collection, "API_ERROR")
                self.assertEqual(self.state(), before)

    def test_native_add_null_or_exception_after_effect_remains_unknown_without_retry(self):
        for operation in OPERATIONS:
            for mode in ("null_after_effect", "raise_after_effect"):
                with self.subTest(operation=operation, mode=mode):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    before = self.state()
                    collection.add_mode = mode
                    result = self.call(operation, args)
                    self.assert_error(result, "API_REJECTED" if mode == "null_after_effect" else "API_ERROR", "unknown")
                    self.assertEqual(collection.add_calls, 1)
                    self.assertEqual(self.env.design.timeline.count, 1)
                    self.assertNotEqual(self.state(), before)

    def test_post_add_naming_failure_reports_partial_and_preserves_actual_effect(self):
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                before = self.state()
                args["name"] = "Requested feature name"
                collection.add_mode = "name_failure"
                result = self.call(operation, args)
                self.assert_error(result, "API_ERROR", "partial")
                self.assertTrue(result["error"]["details"]["effects"])
                self.assertEqual(collection.add_calls, 1)
                self.assertEqual(self.env.design.timeline.count, 1)
                self.assertNotEqual(self.state(), before)

    def test_empty_solid_feature_readback_is_partial_after_successful_add(self):
        for operation in ("features.sweep", "features.loft", "features.draft", "features.split_body", "features.mirror"):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, _ = self.scenario(operation)
                before = self.state()
                collection.body_result_mode = "empty"
                result = self.call(operation, args)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["error"]["outcome"], "partial", result)
                self.assertTrue(result["error"]["details"]["effects"])
                self.assertEqual(collection.add_calls, 1)
                self.assertEqual(self.env.design.timeline.count, 1)
                self.assertNotEqual(self.state(), before)

    def test_every_returned_body_is_checked_and_inconsistent_second_body_is_partial(self):
        for mode in ("non_solid_last", "temporary_last", "proxy_last", "foreign_last"):
            with self.subTest(mode=mode):
                self.reset_fixture()
                args, collection, _ = self.scenario("features.mirror")
                args["body_ids"].append(self.handle(self.body()))
                before = self.state()
                collection.body_result_mode = mode
                result = self.call("features.mirror", args)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["error"]["outcome"], "partial", result)
                self.assertTrue(result["error"]["details"]["effects"])
                self.assertEqual(collection.add_calls, 1)
                self.assertEqual(self.component.bRepBodies.count, 4)
                self.assertNotEqual(self.state(), before)

    def test_empty_cut_or_intersection_result_is_allowed_after_participant_removal(self):
        for operation in ("features.sweep", "features.loft"):
            for effect in ("cut", "intersect"):
                with self.subTest(operation=operation, effect=effect):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    target = self.body()
                    args.update(operation=effect, participant_body_ids=[self.handle(target)])
                    before = self.state()
                    collection.body_result_mode = "empty_removed"
                    result = self.call(operation, args)
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["data"]["bodies"], [])
                    self.assertEqual(self.component.bRepBodies.count, 0)
                    self.assertIs(target.isValid, False)
                    self.assertEqual(collection.add_calls, 1)
                    self.assertNotEqual(result["state"], before)

    def test_unavailable_body_readback_is_partial_even_when_an_empty_cut_would_be_valid(self):
        for operation in ("features.sweep", "features.loft"):
            for effect in ("new_body", "cut", "intersect"):
                with self.subTest(operation=operation, effect=effect):
                    self.reset_fixture()
                    args, collection, _ = self.scenario(operation)
                    if effect != "new_body":
                        args.update(operation=effect, participant_body_ids=[self.handle(self.body())])
                    before = self.state()
                    collection.body_result_mode = "unavailable"
                    result = self.call(operation, args)
                    self.assert_error(result, "FRESHNESS_UNAVAILABLE", "partial")
                    self.assertTrue(result["error"]["details"]["effects"])
                    self.assertEqual(collection.add_calls, 1)
                    self.assertNotEqual(self.state(), before)

    def construction_scenario(self, kind, custom=False):
        obj = self.custom_construction(kind) if custom else (self.component.xYConstructionPlane if kind == "plane" else self.component.zConstructionAxis)
        entity_kind = "construction_plane" if kind == "plane" else "construction_axis"
        observed = self.call("entities.find", {"kind": entity_kind, "name": obj.name}, expected=False)
        self.assertTrue(observed["ok"], observed)
        self.assertEqual(len(observed["data"]["entities"]), 1)
        handle = observed["data"]["entities"][0]["entity_id"]
        if kind == "plane":
            operation = "construction_planes.offset"
            args = {"plane_id": handle, "distance": "1 mm"}
            collection = self.component.constructionPlanes
        else:
            operation = "features.revolve"
            args = {"profile_ids": [self.handle(self.profile())], "axis_id": handle, "angle": "30 deg", "operation": "new_body"}
            collection = self.component.features.revolveFeatures
        return obj, entity_kind, operation, args, collection, observed["data"]["entities"][0]

    def test_construction_summaries_expose_finite_native_frame_and_orientation_fingerprint(self):
        for kind in ("plane", "axis"):
            for custom in (False, True):
                with self.subTest(kind=kind, custom=custom):
                    self.reset_fixture()
                    obj, entity_kind, _, _, _, initial = self.construction_scenario(kind, custom)
                    self.assertFalse(hasattr(obj, "revisionId"))
                    self.assertFalse(hasattr(obj, "parentComponent"))
                    geometry = initial["construction_geometry"]
                    self.assertEqual(geometry["kind"], "plane" if kind == "plane" else "infinite_line")
                    self.assertEqual(geometry["origin_cm"], [1, 2, 3] if custom else [0, 0, 0])
                    self.assertEqual(geometry["frame"]["kind"], "component")
                    self.assertIs(geometry["frame"]["qualified"], True)
                    self.assertEqual(geometry["frame"]["component_id"], self.handle(self.component))
                    self.assertRegex(geometry["fingerprint_sha256"], r"^[0-9a-f]{64}$")
                    vector_field = "normal" if kind == "plane" else "direction"
                    vector = getattr(obj.geometry, vector_field)
                    vector.x, vector.y, vector.z = -vector.x, -vector.y, -vector.z
                    refreshed = self.call("entities.find", {"kind": entity_kind, "name": obj.name}, expected=False)
                    self.assertTrue(refreshed["ok"], refreshed)
                    current = refreshed["data"]["entities"][0]["construction_geometry"]
                    self.assertEqual(current[vector_field], [-v for v in geometry[vector_field]])
                    self.assertNotEqual(current["fingerprint_sha256"], geometry["fingerprint_sha256"])

    def test_state_read_does_not_refresh_old_origin_or_custom_construction_selection(self):
        for kind in ("plane", "axis"):
            for custom in (False, True):
                with self.subTest(kind=kind, custom=custom):
                    self.reset_fixture()
                    obj, entity_kind, operation, args, collection, _ = self.construction_scenario(kind, custom)
                    before = self.call("document.inspect", expected=False)
                    self.assertTrue(before["ok"], before)
                    obj.geometry.origin.x += 0.25
                    current = self.call("document.inspect", expected=False)
                    self.assertTrue(current["ok"], current)
                    self.assertNotEqual(current["state"], before["state"])
                    result = self.runtime.dispatch({"operation": operation, "args": args,
                                                    "document_id": self.document_id, "request_id": "old-selection-fresh-state",
                                                    "expected_state": current["state"]})
                    self.assert_no_add(result, collection, "STALE_ENTITY")
                    refreshed = self.call("entities.find", {"kind": entity_kind, "name": obj.name}, expected=False)
                    self.assertTrue(refreshed["ok"], refreshed)
                    args["plane_id" if kind == "plane" else "axis_id"] = refreshed["data"]["entities"][0]["entity_id"]
                    retried = self.call(operation, args)
                    self.assertTrue(retried["ok"], retried)

    def test_unselected_construction_geometry_drift_invalidates_expected_document_state(self):
        for kind in ("plane", "axis"):
            for custom in (False, True):
                with self.subTest(kind=kind, custom=custom):
                    self.reset_fixture()
                    args, collection, _ = self.scenario("features.mirror")
                    obj = self.custom_construction(kind) if custom else (self.component.xZConstructionPlane if kind == "plane" else self.component.xConstructionAxis)
                    state = self.call("document.inspect", expected=False)["state"]
                    obj.geometry.origin.y += 2
                    result = self.runtime.dispatch({"operation": "features.mirror", "args": args, "document_id": self.document_id,
                                                    "request_id": "unselected-geometry-drift", "expected_state": state})
                    self.assert_no_add(result, collection, "STALE_STATE")

    def test_geometry_drift_during_input_preparation_is_rechecked_before_add(self):
        for operation in ("construction_planes.offset", "features.draft"):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, selected = self.scenario(operation)
                self.env.design.unitsManager.after_validate = lambda: setattr(selected["plane"].geometry.origin, "z", 4)
                result = self.call(operation, args)
                self.assert_no_add(result, collection)
                self.assertIn(result["error"]["code"], ("STALE_STATE", "STALE_ENTITY"), result)

    def test_feature_geometry_revision_drift_rejects_previously_selected_handles(self):
        for operation in ("features.sweep", "features.loft", "features.draft", "features.split_body", "features.mirror"):
            with self.subTest(operation=operation):
                self.reset_fixture()
                args, collection, selected = self.scenario(operation)
                if operation == "features.sweep":
                    selected["path"][0].parentSketch.changed()
                elif operation == "features.loft":
                    selected["profiles"][1].parentSketch.changed()
                else:
                    selected["body"].revisionId = "changed-after-selection"
                # A fresh document token does not authorize a stale selection.
                self.assert_no_add(self.call(operation, args), collection, "STALE_ENTITY")

    def test_missing_nonfinite_and_zero_construction_geometry_fail_closed(self):
        for kind in ("plane", "axis"):
            for custom in (False, True):
                for damage in ("missing_geometry", "missing_origin", "missing_vector", "nan_origin", "infinite_vector", "zero_vector", "wrong_type"):
                    with self.subTest(kind=kind, custom=custom, damage=damage):
                        self.reset_fixture()
                        obj, _, operation, args, collection, _ = self.construction_scenario(kind, custom)
                        vector_field = "normal" if kind == "plane" else "direction"
                        if damage == "missing_geometry":
                            del obj.geometry
                        elif damage == "missing_origin":
                            del obj.geometry.origin
                        elif damage == "missing_vector":
                            delattr(obj.geometry, vector_field)
                        elif damage == "nan_origin":
                            obj.geometry.origin.x = float("nan")
                        elif damage == "infinite_vector":
                            getattr(obj.geometry, vector_field).z = float("inf")
                        elif damage == "zero_vector":
                            setattr(obj.geometry, vector_field, base.Point())
                        else:
                            obj.geometry.objectType = "adsk::core::Cylinder"
                        # Even an explicit attempted reinspection cannot make
                        # unavailable geometry a usable mutation reference.
                        args["plane_id" if kind == "plane" else "axis_id"] = self.handle(obj)
                        observed = self.call("document.inspect", expected=False)
                        self.assertTrue(observed["ok"], observed)
                        self.assertTrue(any("construction" in gap for gap in observed["data"].get("freshness_gaps", [])), observed)
                        json.dumps(observed, allow_nan=False)
                        self.assert_no_add(self.call(operation, args), collection, "FRESHNESS_UNAVAILABLE")

    def test_unavailable_unselected_geometry_blocks_other_document_effects(self):
        for kind, custom in (("plane", False), ("axis", True)):
            with self.subTest(kind=kind, custom=custom):
                self.reset_fixture()
                obj = self.custom_construction(kind) if custom else self.component.xZConstructionPlane
                obj.geometry = None
                result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
                self.assert_error(result, "FRESHNESS_UNAVAILABLE")
                self.assertEqual(self.env.design.batch_calls, [])
                self.assertEqual(self.env.param.expression, "10 mm")

    def test_existing_sketch_creation_uses_real_construction_plane_component(self):
        for child in (False, True):
            with self.subTest(child=child):
                self.reset_fixture()
                component = self.child_component() if child else self.component
                plane = component.xYConstructionPlane
                self.assertFalse(hasattr(plane, "parentComponent"))
                calls = []

                def add_sketch(support):
                    calls.append(support)
                    return component.add_sketch(support)

                component.sketches.add = add_sketch
                result = self.call("sketches.create", {"component_id": self.handle(component), "plane": {"entity_id": self.handle(plane)}})
                self.assertTrue(result["ok"], result)
                self.assertEqual(calls, [plane])
                self.assertIs(component.sketches.items[0].parentComponent, component)

    def test_existing_revolve_uses_real_construction_axis_component(self):
        for child in (False, True):
            with self.subTest(child=child):
                self.reset_fixture()
                component = self.child_component() if child else self.component
                axis = component.zConstructionAxis
                profile = self.profile(component)
                self.assertFalse(hasattr(axis, "parentComponent"))
                result = self.call("features.revolve", {"profile_ids": [self.handle(profile)], "axis_id": self.handle(axis),
                                                       "angle": "45 deg", "operation": "new_body"})
                self.assertTrue(result["ok"], result)
                self.assertIs(component.features.revolveFeatures.last_input.args[1], axis)

    def test_existing_extrude_and_revolve_require_computed_profile_membership(self):
        for operation in ("features.extrude", "features.revolve"):
            for condition in ("uncomputed", "missing_compute_flag", "not_in_sketch"):
                with self.subTest(operation=operation, condition=condition):
                    self.reset_fixture()
                    profile = self.profile()
                    args = {"profile_ids": [self.handle(profile)], "operation": "new_body"}
                    if operation == "features.extrude":
                        args["distance"] = "5 mm"
                        collection = self.component.features.extrudeFeatures
                    else:
                        args.update(axis_id=self.handle(self.component.zConstructionAxis), angle="45 deg")
                        collection = self.component.features.revolveFeatures
                    if condition == "uncomputed":
                        profile.parentSketch.isComputeDeferred = True
                    elif condition == "missing_compute_flag":
                        del profile.parentSketch.isComputeDeferred
                    else:
                        profile.parentSketch.profiles.items.remove(profile)
                    self.assert_no_add(self.call(operation, args), collection)
                    self.assertIsNone(collection.last_input)

    def test_existing_extrude_and_revolve_reject_nonpersistent_or_nonsolid_participants(self):
        for operation in ("features.extrude", "features.revolve"):
            for condition in ("temporary", "surface"):
                with self.subTest(operation=operation, condition=condition):
                    self.reset_fixture()
                    profile = self.profile()
                    body = self.body(solid=condition != "surface", temporary=condition == "temporary")
                    args = {"profile_ids": [self.handle(profile)], "operation": "cut", "participant_body_ids": [self.handle(body)]}
                    if operation == "features.extrude":
                        args["distance"] = "5 mm"
                        collection = self.component.features.extrudeFeatures
                    else:
                        args.update(axis_id=self.handle(self.component.zConstructionAxis), angle="45 deg")
                        collection = self.component.features.revolveFeatures
                    self.assert_no_add(self.call(operation, args), collection)


if __name__ == "__main__":
    unittest.main()
