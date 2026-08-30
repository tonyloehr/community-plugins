"""Offline contract tests, not Autodesk kernel or licensed CAM qualification.

The doubles model only the public members each test exercises. They deliberately
omit retired or invented members so an incorrect call fails. Run with:
python3 -m unittest discover -s plugins/autodesk-fusion/tests/python -v
"""

import hashlib
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch


HANDLER_PATH = Path(__file__).resolve().parents[2] / "handlers" / "fusion_runtime.py"


class Collection:
    def __init__(self, items=()):
        self.items = list(items)

    @property
    def count(self):
        return len(self.items)

    def item(self, index):
        return self.items[index]

    def add(self, obj):
        self.items.append(obj)
        return True

    def itemByName(self, name):
        return next((i for i in self.items if getattr(i, "name", None) == name), None)

    def itemById(self, object_id):
        return next((i for i in self.items if getattr(i, "id", None) == object_id), None)

    def itemByOperationId(self, object_id):
        return next((i for i in self.items if getattr(i, "operationId", None) == object_id), None)


class Object:
    def __init__(self, object_type, **properties):
        self.objectType = object_type
        self.isValid = True
        self.__dict__.update(properties)


class Point:
    def __init__(self, x=0, y=0, z=0):
        self.x, self.y, self.z = x, y, z


class Matrix:
    def __init__(self, numbers=None):
        self.numbers = list(numbers or [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

    def setWithArray(self, numbers):
        self.numbers = list(numbers)
        return True

    def asArray(self):
        return list(self.numbers)


class Units:
    defaultLengthUnits = "mm"

    def __init__(self):
        self.after_validate = None

    def isValidExpression(self, expression, unit):
        try:
            self.evaluateExpression(expression, unit)
        except (ValueError, KeyError):
            return False
        if self.after_validate is not None:
            hook, self.after_validate = self.after_validate, None
            hook()
        return True

    def evaluateExpression(self, expression, unit):
        # No Python eval, including in the fake parser.
        match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*", expression)
        if not match:
            raise ValueError("Unsupported fake expression")
        value = float(match.group(1))
        suffix = match.group(2)
        length = {"mm": 0.1, "cm": 1.0, "m": 100.0, "in": 2.54}
        angle = {"rad": 1.0, "deg": math.pi / 180.0}
        if unit in length:
            return value * length[suffix or unit]
        if unit in angle:
            return value * angle[suffix or unit]
        if unit == "" and suffix == "":
            return value
        raise ValueError("Dimensional mismatch")


class Parameter(Object):
    def __init__(self, name="Length", expression="10 mm", unit="mm", token="parameter-token"):
        super().__init__("adsk::fusion::UserParameter", name=name, expression=expression,
                         unit=unit, value=1.0, entityToken=token)


def physical_properties():
    return NS(mass=0.0027, volume=1.0, area=6.0, centerOfMass=Point(0.5, 0.5, 0.5), density=0.0027)


class MaterialProperty(Object):
    def __init__(self, property_id, kind, value, units=""):
        super().__init__("adsk::core::" + kind + "Property", id=property_id, name="Localized " + property_id,
                         isReadOnly=False, value=value)
        if kind in ("Float", "Integer", "Color", "Filename"):
            self.hasMultipleValues = False
            self.values = [value]
        if kind in ("Float", "Color"):
            self.hasConnectedTexture = False
        if kind == "Float":
            self.units = units


class Material(Object):
    def __init__(self, material_id="aluminum", density=0.0027):
        super().__init__("adsk::core::Material", id=material_id, name="Aluminum", description="Synthetic engineering material",
                         materialProperties=Collection([MaterialProperty("physical_density", "Float", density, "kg/cm^3"),
                                                        MaterialProperty("yield_strength", "Float", 275.0, "MPa"),
                                                        MaterialProperty("structure_type", "Choice", "isotropic")]))


class Body(Object):
    def __init__(self, component, name="Body", revision="body-r1"):
        super().__init__("adsk::fusion::BRepBody", parentComponent=component, name=name,
                         revisionId=revision, isSolid=True, isSheetMetal=False, volume=1.0,
                         material=component.material, faces=Collection(), edges=Collection(),
                         boundingBox=NS(minPoint=Point(), maxPoint=Point(1, 1, 1)))

    def getPhysicalProperties(self, accuracy):
        return physical_properties()


class Face(Object):
    def __init__(self, body, token="face-token"):
        super().__init__("adsk::fusion::BRepFace", body=body, entityToken=token,
                         geometry=Object("adsk::core::Plane", origin=Point(), normal=Point(0, 0, 1)))


class Sketch(Object):
    def __init__(self, component):
        super().__init__("adsk::fusion::Sketch", parentComponent=component, name="Sketch",
                         revisionId="sketch-r1", profiles=Collection(), sketchPoints=Collection(),
                         isFullyConstrained=False)
        self.sketchCurves = Curves(self)
        self.sketchDimensions = Dimensions(self)
        self.geometricConstraints = Constraints(self)

    def changed(self):
        self.revisionId += "x"


class Curves(Collection):
    def __init__(self, sketch):
        super().__init__()
        self.sketch = sketch
        self.sketchLines = self
        self.sketchCircles = Circles(sketch, self)
        self.calls = 0
        self.fail_on = None

    def addByTwoPoints(self, start, end):
        self.calls += 1
        if self.calls == self.fail_on:
            raise RuntimeError("Synthetic kernel rejection on this curve")
        sp = Object("adsk::fusion::SketchPoint", parentSketch=self.sketch, geometry=start)
        ep = Object("adsk::fusion::SketchPoint", parentSketch=self.sketch, geometry=end)
        curve = Object("adsk::fusion::SketchLine", parentSketch=self.sketch, startSketchPoint=sp, endSketchPoint=ep)
        self.items.append(curve)
        self.sketch.sketchPoints.items.extend([sp, ep])
        self.sketch.changed()
        return curve

    def addTwoPointRectangle(self, first, second):
        vertices = [first, Point(second.x, first.y), second, Point(first.x, second.y)]
        curves = [self.addByTwoPoints(vertices[i], vertices[(i + 1) % 4]) for i in range(4)]
        self.sketch.profiles.items.append(Object("adsk::fusion::Profile", parentSketch=self.sketch))
        return Collection(curves)


class Circles(Collection):
    def __init__(self, sketch, all_curves):
        super().__init__()
        self.sketch, self.all_curves = sketch, all_curves

    def addByCenterRadius(self, point, radius):
        circle = Object("adsk::fusion::SketchCircle", parentSketch=self.sketch, center=point, radius=radius)
        self.items.append(circle)
        self.all_curves.items.append(circle)
        self.sketch.profiles.items.append(Object("adsk::fusion::Profile", parentSketch=self.sketch))
        self.sketch.changed()
        return circle


class Dimensions:
    def __init__(self, sketch):
        self.sketch = sketch

    def addDistanceDimension(self, point1, point2, orientation, text, driving):
        return Object("adsk::fusion::SketchLinearDimension", parentSketch=self.sketch,
                      parameter=Parameter("distance", token="dimension-token"))

    def addDiameterDimension(self, curve, point, driving):
        return Object("adsk::fusion::SketchDiameterDimension", parentSketch=self.sketch,
                      parameter=Parameter("diameter", token="diameter-token"))

    def addRadialDimension(self, curve, point, driving):
        return Object("adsk::fusion::SketchRadialDimension", parentSketch=self.sketch,
                      parameter=Parameter("radius", token="radius-token"))


class Constraints:
    def __init__(self, sketch):
        self.sketch = sketch
        self.calls = []

    def _add(self, kind, *entities):
        self.calls.append((kind, entities))
        self.sketch.changed()
        return Object("adsk::fusion::" + kind + "Constraint", parentSketch=self.sketch)

    def addCoincident(self, point, entity):
        return self._add("Coincident", point, entity)

    def addHorizontal(self, line):
        return self._add("Horizontal", line)

    def addVertical(self, line):
        return self._add("Vertical", line)

    def addParallel(self, first, second):
        return self._add("Parallel", first, second)

    def addPerpendicular(self, first, second):
        return self._add("Perpendicular", first, second)

    def addCollinear(self, first, second):
        return self._add("Collinear", first, second)

    def addConcentric(self, first, second):
        return self._add("Concentric", first, second)

    def addEqual(self, first, second):
        return self._add("Equal", first, second)

    def addTangent(self, first, second):
        return self._add("Tangent", first, second)

    def addMidPoint(self, point, line):
        return self._add("MidPoint", point, line)

    def addHorizontalPoints(self, first, second):
        return self._add("HorizontalPoints", first, second)

    def addVerticalPoints(self, first, second):
        return self._add("VerticalPoints", first, second)


class FeatureInput:
    def __init__(self):
        self.extent = None
        self.direction = None
        self.edgeSetInputs = NS(addConstantRadiusEdgeSet=self.fillet)
        self.chamferEdgeSets = NS(addEqualDistanceChamferEdgeSet=self.chamfer)

    def setOneSideExtent(self, extent, direction):
        self.extent, self.direction = extent, direction
        return True

    def setAngleExtent(self, symmetric, angle):
        self.symmetric, self.angle = symmetric, angle
        return True

    def setPositionByPoint(self, face, point):
        self.face, self.point = face, point
        return True

    def setDistanceExtent(self, depth):
        self.depth = depth
        return True

    def fillet(self, edges, radius, tangent):
        self.edges, self.radius, self.tangent = edges, radius, tangent
        return NS()

    def chamfer(self, edges, distance, tangent):
        self.edges, self.distance, self.tangent = edges, distance, tangent
        return True

    def setAsRigidJointMotion(self):
        self.motion = "rigid"
        return True


class FeatureCollection:
    def __init__(self, component, feature_type):
        self.component, self.feature_type = component, feature_type
        self.inputs = []
        self.last_input = None
        self.used_create_input2 = False

    def createInput(self, *args):
        self.last_input = FeatureInput()
        self.last_input.args = args
        return self.last_input

    def createInput2(self):
        self.used_create_input2 = True
        return self.createInput()

    def createSimpleInput(self, diameter):
        inp = self.createInput()
        inp.diameter = diameter
        return inp

    def add(self, inp):
        self.inputs.append(inp)
        feature = Object(self.feature_type, parentComponent=self.component, name="Feature", healthState=0,
                         errorOrWarningMessage="", bodies=self.component.bRepBodies)
        self.component.features.items.append(feature)
        return feature


class Component(Object):
    def __init__(self, design, component_id="root", name="Root"):
        super().__init__("adsk::fusion::Component", parentDesign=design, id=component_id, name=name,
                         partNumber="PN-001", description="Synthetic contract part", bRepBodies=Collection(),
                         sketches=Collection(), allOccurrences=Collection(), occurrences=Collection(),
                         material=Material(), features=Collection(), flatPattern=None,
                         constructionAxes=Collection(), constructionPlanes=Collection())
        for name in ("xConstructionAxis", "yConstructionAxis", "zConstructionAxis"):
            setattr(self, name, Object("adsk::fusion::ConstructionAxis", parentComponent=self, name=name))
        for name in ("xYConstructionPlane", "xZConstructionPlane", "yZConstructionPlane"):
            setattr(self, name, Object("adsk::fusion::ConstructionPlane", parentComponent=self, name=name))
        for name, obj_type in (("extrude", "Extrude"), ("revolve", "Revolve"), ("hole", "Hole"),
                               ("fillet", "Fillet"), ("chamfer", "Chamfer"), ("shell", "Shell"),
                               ("combine", "Combine"), ("circularPattern", "CircularPattern")):
            setattr(self.features, name + "Features", FeatureCollection(self, "adsk::fusion::" + obj_type + "Feature"))
        self.asBuiltJoints = FeatureCollection(self, "adsk::fusion::AsBuiltJoint")
        self.sketches.add = self.add_sketch

    def add_sketch(self, plane):
        sketch = Sketch(self)
        self.sketches.items.append(sketch)
        return sketch

    def getPhysicalProperties(self, accuracy):
        return physical_properties()


class Occurrence(Object):
    def __init__(self, component, name="Part:1"):
        super().__init__("adsk::fusion::Occurrence", component=component, name=name, fullPathName=name,
                         transform2=Matrix(), isGrounded=False, isReferencedComponent=False,
                         childOccurrences=Collection(), bRepBodies=component.bRepBodies, isVisible=True)
        self.documentReference = NS(dataFile=NS(id="source-lineage", versionId="source-version-1", versionNumber=1,
                                               isComplete=True, parentProject=NS(id="project-1"), parentFolder=NS(id="folder-1")),
                                    version=1, isOutOfDate=False)

    def getPhysicalProperties(self, accuracy):
        return physical_properties()


class Design(Object):
    def __init__(self):
        super().__init__("adsk::fusion::Design", productType="DesignProductType", designType=1,
                         isConfiguredDesign=False, isConfiguration=False, configurationTopTable=None,
                         unitsManager=Units(), allParameters=Collection(), userParameters=Collection(),
                         timeline=Collection(), snapshots=NS(hasPendingSnapshot=False))
        self.timeline.markerPosition = 0
        self.rootComponent = Component(self)
        self.allComponents = Collection([self.rootComponent])
        self.tokens = {}
        self.batch_calls = []
        self.batch_accept = True
        self.batch_exception = False
        self.userParameters.add = self.add_parameter
        self.exportManager = ExportManager()
        self.renderManager = NS(rendering=Rendering())

    def findEntityByToken(self, token):
        return self.tokens.get(token, [])

    def add_parameter(self, name, value, unit, comment):
        parameter = Parameter(name, value.expression, unit, "token-" + name)
        self.allParameters.items.append(parameter)
        self.userParameters.items.append(parameter)
        self.tokens[parameter.entityToken] = [parameter]
        return parameter

    def modifyParameters(self, parameters, values):
        self.batch_calls.append((parameters, values))
        if not self.batch_accept:
            return False
        for parameter, value in zip(parameters, values):
            parameter.expression = value.expression
            parameter.value = self.unitsManager.evaluateExpression(value.expression, parameter.unit)
            if self.batch_exception:
                raise RuntimeError("Synthetic interrupted kernel update")
        return True


class Products(Collection):
    def itemByProductType(self, product_type):
        return next((p for p in self.items if p.productType == product_type), None)


class Document(Object):
    def __init__(self, app, design=None, creation_id="copied-creation-id"):
        super().__init__("adsk::fusion::FusionDocument", creationId=creation_id, name="Part",
                         isSaved=False, isModified=False, isUpToDate=True, dataFile=None,
                         products=Products([design] if design else []))
        self.app, self.design = app, design
        self.close_calls = []
        self.save_calls = []

    def activate(self):
        self.app.activeDocument = self
        return True

    def close(self, save):
        self.close_calls.append(save)
        self.isValid = False
        self.app.documents.items.remove(self)
        self.app.activeDocument = self.app.documents.items[0] if self.app.documents.items else None
        return True

    def save(self, description):
        self.save_calls.append(description)
        self.isModified = False
        self.dataFile.isComplete = False
        return True


class ExportManager:
    def __init__(self):
        self.options = None
        self.execute_calls = 0

    def createSTLExportOptions(self, geometry, filename):
        self.options = NS(geometry=geometry, filename=filename, surfaceDeviation=0.01,
                          normalDeviation=0.1, maximumEdgeLength=0.2)
        return self.options

    def createSTEPExportOptions(self, filename, geometry):
        self.options = NS(geometry=geometry, filename=filename)
        return self.options

    def createFusionArchiveExportOptions(self, filename, geometry):
        self.options = NS(geometry=geometry, filename=filename)
        return self.options

    def execute(self, options):
        self.execute_calls += 1
        Path(options.filename).write_bytes(b"synthetic artifact contract bytes")
        return True


class Rendering:
    def __init__(self):
        self.aspectRatio = 0
        self.resolutionWidth = 1080
        self.resolutionHeight = 720
        self.renderQuality = 75
        self.calls = []

    def startLocalRender(self, filename, camera):
        self.calls.append((filename, self.resolutionWidth, self.resolutionHeight, self.renderQuality))
        self.future = Object("adsk::fusion::RenderFuture", renderState=0, progress=0.0,
                             imageWidth=self.resolutionWidth, imageHeight=self.resolutionHeight, filename=filename)
        return self.future


class CamValue(Object):
    def __init__(self, kind, value, choices=None):
        super().__init__("adsk::cam::" + kind + "ParameterValue", value=value)
        self.choices = choices or []

    def getChoices(self):
        return True, ["Localized " + str(c) for c in self.choices], self.choices


class CamParameter(Object):
    def __init__(self, name, kind, value, choices=None):
        super().__init__("adsk::cam::CAMParameter", name=name, value=CamValue(kind, value, choices),
                         expression=str(value), systemDefaultExpression=str(value),
                         isEditable=True, isEnabled=True, isDeprecated=False, error="", warning="")


class Tool(Object):
    def __init__(self, number=1, tool_id="tool-one", holder=None):
        super().__init__("adsk::cam::Tool", parameters=Collection([CamParameter("tool_number", "Integer", number)]))
        self.number, self.tool_id = number, tool_id
        self.holder = holder if holder is not None else {"description": "Synthetic holder", "segments": [{"height": 10, "upper-diameter": 30, "lower-diameter": 20}]}

    def toJson(self):
        return json.dumps({"number": self.number, "tool_id": self.tool_id, "holder": self.holder})


class Machine(Object):
    def __init__(self):
        super().__init__("adsk::cam::Machine", id="machine-1", vendor="Autodesk", model="Synthetic", description="Offline fixture")
        self.definition_version = 1

    def equivalentTo(self, other):
        return self.id == other.id and self.definition_version == other.definition_version


class Operation(Object):
    def __init__(self, setup, operation_id=1, tool=None):
        super().__init__("adsk::cam::Operation", parentSetup=setup, operationId=operation_id, name="Face " + str(operation_id),
                         isSuppressed=False, isGenerating=False, hasError=False, hasWarning=False,
                         error="", warning="", hasToolpath=True, isToolpathValid=True, operationState=0,
                         strategy="face", tool=tool or Tool(), parameters=Collection())


class Setup(Object):
    def __init__(self, machine):
        super().__init__("adsk::cam::Setup", operationId=100, name="Setup", operationType=1,
                         isSuppressed=False, hasError=False, hasWarning=False, error="", warning="",
                         parameters=Collection(), workCoordinateSystem=Matrix(), machine=machine,
                         models=[], fixtures=[], fixtureEnabled=False, stockMode=1,
                         allOperations=Collection(), operations=Collection())
        self.machine = machine
        self.operations.compatibleStrategies = [NS(name="face", isGenerationAllowed=True), NS(name="adaptive", isGenerationAllowed=True)]
        self.operations.createInput = self.operation_input
        self.input_calls = 0
        self.add_calls = 0
        self.operations.add = self.add_operation

    @property
    def machine(self):
        return copy.copy(self._machine)

    @machine.setter
    def machine(self, value):
        self._machine = value

    def operation_input(self, strategy):
        self.input_calls += 1
        self.latest_input = NS(strategy=strategy, parameters=Collection(), generationMode=None, tool=None)
        return self.latest_input

    def add_operation(self, input_obj):
        self.add_calls += 1
        op = Operation(self, self.add_calls + 1, input_obj.tool)
        self.allOperations.items.append(op)
        return op


def nc_parameters():
    return Collection([CamParameter("nc_program_name", "String", "old"),
                       CamParameter("nc_program_filename", "String", "old"),
                       CamParameter("nc_program_nc_extension", "String", "old"),
                       CamParameter("nc_program_output_folder", "String", "old"),
                       CamParameter("nc_program_openInEditor", "Boolean", True),
                       CamParameter("nc_program_postToFusionTeam", "Boolean", True),
                       CamParameter("nc_program_orderByTool", "Boolean", True),
                       CamParameter("nc_program_unit", "Choice", "document", ["millimeters", "inches", "document"])])


class NcProgram(Object):
    def __init__(self, cam, input_obj):
        super().__init__("adsk::cam::NCProgram", operationId=999, name="Candidate", hasError=False,
                         hasWarning=False, isSuppressed=False, error="", warning="",
                         parameters=input_obj.parameters, postParameters=Collection(),
                         filteredOperations=list(reversed(input_obj.operations)) if cam.reverse_order else input_obj.operations,
                         machine=None)
        self.cam = cam
        self.post_calls = []

    @property
    def postConfiguration(self):
        return self._post

    @postConfiguration.setter
    def postConfiguration(self, post):
        self._post = post
        # Model the dangerous preference reset: handler must reapply controls
        # on the real program after assigning the machine and post.
        self.parameters.itemByName("nc_program_postToFusionTeam").value.value = True
        self.parameters.itemByName("nc_program_openInEditor").value.value = True

    def updatePostParameters(self, parameters):
        return True

    def postProcess(self, options):
        self.post_calls.append(options)
        self.cam.app.hasActiveJobs = self.cam.background_post
        folder = Path(self.parameters.itemByName("nc_program_output_folder").value.value)
        name = self.parameters.itemByName("nc_program_filename").value.value
        extension = self.parameters.itemByName("nc_program_nc_extension").value.value
        (folder / (name + "." + extension)).write_text("(SYNTHETIC CONTRACT NC: DO NOT MACHINE)\nM30\n")
        return True


class Cam(Object):
    def __init__(self, app):
        super().__init__("adsk::cam::CAM", productType="CAMProductType")
        self.app = app
        self.machine = Machine()
        self.setup = Setup(self.machine)
        self.setups = Collection([self.setup])
        self.operation = Operation(self.setup)
        self.setup.allOperations.items.append(self.operation)
        self.allMachines = [self.machine]
        self.ncPrograms = Collection()
        self.ncPrograms.createInput = lambda: NS(parameters=nc_parameters(), displayName="", operations=[])
        self.ncPrograms.add = self.add_nc
        self.nc_add_calls = 0
        self.reverse_order = False
        self.background_post = False
        self.generate_calls = 0

    def add_nc(self, input_obj):
        self.nc_add_calls += 1
        self.program = NcProgram(self, input_obj)
        self.ncPrograms.items.append(self.program)
        return self.program

    def generateToolpath(self, operations):
        self.generate_calls += 1
        self.future = Object("adsk::cam::GenerateToolpathFuture", isGenerationCompleted=False,
                             numberOfOperations=operations.count, numberOfCompleted=0)
        return self.future


class Environment:
    def __init__(self):
        self.app = NS(userInterface=NS(activeCommand="SelectCommand"), documents=Collection(),
                      version="OFFLINE-API-DOUBLE", activeDocument=None, hasActiveJobs=False)
        self.design = Design()
        self.doc = Document(self.app, self.design)
        self.app.documents.items.append(self.doc)
        self.app.activeDocument = self.doc
        self.app.activeViewport = NS(parentDocument=self.doc,
                                    camera=NS(eye=Point(10, 10, 10), target=Point(), upVector=Point(0, 0, 1)))
        self.app.importManager = ImportManager(self.app)
        self.param = Parameter()
        self.design.allParameters.items.append(self.param)
        self.design.userParameters.items.append(self.param)
        self.design.tokens[self.param.entityToken] = [self.param]
        self.cam = Cam(self.app)
        self.post = NS(extension="nc", description="Synthetic post", version="fixture")
        self.library_manager = NS(machineLibrary=NS(machineAtURL=lambda url: self.cam.machine),
                                  postLibrary=NS(postConfigurationAtURL=lambda url: self.post))
        self.api = NS(core=NS(Application=NS(get=lambda: self.app), ObjectCollection=NS(create=Collection),
                              Point3D=NS(create=Point), Matrix3D=NS(create=Matrix),
                              ValueInput=NS(createByString=lambda value: NS(expression=value), createByReal=lambda value: NS(value=value)),
                              DocumentTypes=NS(FusionDesignDocumentType=1), URL=NS(create=lambda url: url)),
                      fusion=NS(DesignTypes=NS(ParametricDesignType=1),
                                Design=NS(cast=lambda product: product if product.objectType == "adsk::fusion::Design" else None),
                                CalculationAccuracy=NS(LowCalculationAccuracy=0, MediumCalculationAccuracy=1, HighCalculationAccuracy=2, VeryHighCalculationAccuracy=3),
                                DistanceExtentDefinition=NS(create=lambda value: NS(distance=value)),
                                ExtentDirections=NS(PositiveExtentDirection=1),
                                FeatureOperations=NS(NewBodyFeatureOperation=0, JoinFeatureOperation=1, CutFeatureOperation=2, IntersectFeatureOperation=3),
                                DimensionOrientations=NS(HorizontalDimensionOrientation=0, VerticalDimensionOrientation=1, AlignedDimensionOrientation=2),
                                DistanceUnits=NS(MillimeterDistanceUnits=0, CentimeterDistanceUnits=1, MeterDistanceUnits=2, InchDistanceUnits=3),
                                MeshRefinementSettings=NS(MeshRefinementLow=0, MeshRefinementMedium=1, MeshRefinementHigh=2),
                                RenderAspectRatios=NS(CustomRenderAspectRatio=6),
                                LocalRenderStates=NS(QueuedLocalRenderState=0, ProcessingLocalRenderState=1, FinishedLocalRenderState=2, FailedLocalRenderState=3)),
                      cam=NS(OperationTypes=NS(MillingOperation=1), SetupStockModes=NS(RelativeBoxStock=1, FixedBoxStock=2),
                             CAM=NS(cast=lambda product: product if product.objectType == "adsk::cam::CAM" else None),
                             AutomaticGenerationModes=NS(SkipGeneration=1), Tool=NS(createFromJson=lambda source: Tool()),
                             ToolLibrary=NS(createFromJson=lambda source: Collection([Tool(item["number"], item["tool_id"], item.get("holder")) for item in json.loads(source)["data"]])),
                             SetupSheetFormats=NS(HTMLFormat=0),
                             CAMManager=NS(get=lambda: NS(libraryManager=self.library_manager)),
                             NCProgramPostProcessOptions=NS(create=NS),
                             PostProcessExecutionBehaviors=NS(PostProcessExecutionBehavior_Fail=2),
                             FusionHubExecutionBehaviors=NS(FusionHubExecutionBehavior_SkipRelationship=3)))
        for kind in ("Float", "Integer", "Boolean", "String", "Choice", "Color", "Filename"):
            object_type = "adsk::core::" + kind + "Property"
            setattr(self.api.core, kind + "Property", NS(cast=lambda prop, expected=object_type: prop if prop.objectType == expected else None))

    def enable_cam(self):
        self.doc.products.items.append(self.cam)


class ImportManager:
    def __init__(self, app):
        self.app = app
        self.calls = []

    def createSTEPImportOptions(self, filename):
        return NS(filename=filename, format="step", isViewFit=True)

    def createFusionArchiveImportOptions(self, filename):
        return NS(filename=filename, format="f3d", isViewFit=True)

    def importToNewDocument(self, options):
        self.calls.append(options)
        doc = Document(self.app, Design(), creation_id="imported-creation")
        self.app.documents.items.append(doc)
        self.app.activeDocument = doc
        return doc


class RuntimeContracts(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("fusion_runtime_test_" + self.id(), HANDLER_PATH)
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)
        self.env = Environment()
        self.runtime._API = self.env.api
        self.document_id = self.runtime._document_id(self.env.doc)
        self.ctx = self.runtime._Context({"operation": "test", "args": {}, "document_id": self.document_id}, self.env.app)
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def handle(self, obj):
        return self.runtime._register(self.ctx, obj)

    def state(self):
        return self.runtime._state(self.ctx)[0]

    def call(self, operation, args=None, expected=True, document=True):
        request = {"operation": operation, "args": args or {}, "request_id": "contract-test-request"}
        if document:
            request["document_id"] = self.document_id
        if expected and document:
            request["expected_state"] = self.state()
        return self.runtime.dispatch(request)

    def assert_error(self, result, code, outcome="none"):
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], code, result)
        self.assertEqual(result["error"]["outcome"], outcome, result)

    def add_body(self):
        body = Body(self.env.design.rootComponent)
        self.env.design.rootComponent.bRepBodies.items.append(body)
        return body

    def add_sketch(self):
        return self.env.design.rootComponent.add_sketch(None)

    def nc_args(self):
        self.env.enable_cam()
        post = self.directory / "approved.cps"
        machine = self.directory / "approved.machine"
        output = self.directory / "quarantine"
        tools = self.directory / "approved-tools.json"
        post.write_text("// Synthetic reviewed fixture, not a production post")
        machine.write_text("Synthetic machine definition for API doubles only")
        tools.write_text(json.dumps({"data": [json.loads(Tool().toJson()), json.loads(Tool(number=2).toJson())]}))
        output.mkdir(mode=0o700)
        return {"operation_ids": [self.handle(self.env.cam.operation)], "post_config_path": str(post),
                "post_sha256": hashlib.sha256(post.read_bytes()).hexdigest(), "output_folder": str(output),
                "program_name": "contract_candidate", "units": "mm",
                "machine_profile": {"id": self.env.cam.machine.id, "source_path": str(machine),
                                    "sha256": hashlib.sha256(machine.read_bytes()).hexdigest()},
                "tool_library": {"source_path": str(tools), "sha256": hashlib.sha256(tools.read_bytes()).hexdigest()},
                "verification": {"method": "Synthetic offline contract verification only", "reviewed_by": "test fixture", "source_state": self.state()}}

    def material_library(self, material=None):
        material = material or Material("approved-library-material", 0.00785)
        library = Object("adsk::core::MaterialLibrary", id="approved-materials", name="Synthetic approved library",
                         materials=Collection([material]))
        self.env.app.materialLibraries = Collection([library])
        return library, material

    def test_module_import_does_not_require_autodesk(self):
        self.runtime._API = None
        with patch.object(self.runtime.importlib, "import_module", side_effect=ImportError):
            result = self.call("documents.list", document=False)
        self.assert_error(result, "FUSION_UNAVAILABLE")

    def test_unknown_operation_never_loads_api_or_evaluates_code(self):
        with patch.object(self.runtime, "_api", side_effect=AssertionError("Must not load API")):
            result = self.runtime.dispatch({"operation": "python.exec", "args": {"source": "raise Exception()"}, "request_id": "x"})
        self.assert_error(result, "UNSUPPORTED_OPERATION")

    def test_wrong_thread_denied_before_autodesk_access(self):
        results = []
        thread = threading.Thread(target=lambda: results.append(self.call("documents.list", document=False)))
        thread.start()
        thread.join()
        self.assert_error(results[0], "WRONG_THREAD")

    def test_unknown_argument_fails_before_side_effect(self):
        result = self.call("parameters.set", {"changes": [], "python_code": "malicious"})
        self.assert_error(result, "INVALID_ARGUMENT")
        self.assertFalse(self.env.design.batch_calls)

    def test_creation_id_copies_do_not_alias_documents(self):
        copy = Document(self.env.app, Design())
        self.env.app.documents.items.append(copy)
        result = self.call("documents.list", document=False)
        docs = result["data"]["documents"]
        self.assertEqual(docs[0]["creation_id"], docs[1]["creation_id"])
        self.assertNotEqual(docs[0]["document_id"], docs[1]["document_id"])

    def test_closed_document_handle_never_falls_back_to_active_tab(self):
        old = self.document_id
        self.env.doc.close(False)
        replacement = Document(self.env.app, Design())
        self.env.app.documents.items.append(replacement)
        self.env.app.activeDocument = replacement
        result = self.runtime.dispatch({"operation": "document.inspect", "args": {}, "document_id": old, "request_id": "x"})
        self.assert_error(result, "DOCUMENT_NOT_FOUND")

    def test_cross_document_entity_cannot_mutate(self):
        handle = self.handle(self.env.param)
        other = Document(self.env.app, Design())
        self.env.app.documents.items.append(other)
        self.document_id = self.runtime._document_id(other)
        result = self.call("parameters.set", {"changes": [{"parameter_id": handle, "expression": "20 mm"}]})
        self.assert_error(result, "ENTITY_NOT_FOUND")
        self.assertFalse(self.env.design.batch_calls)

    def test_busy_ui_command_rejects_mutation(self):
        self.env.app.userInterface.activeCommand = "ExtrudeCommand"
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "FUSION_BUSY")
        self.assertFalse(self.env.design.batch_calls)

    def test_expected_state_required_for_effect(self):
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]}, expected=False)
        self.assert_error(result, "EXPECTED_STATE_REQUIRED")

    def test_freshness_rechecked_after_input_validation_before_write(self):
        handle = self.handle(self.env.param)
        expected = self.state()
        self.env.design.unitsManager.after_validate = lambda: setattr(self.env.param, "expression", "99 mm")
        result = self.runtime.dispatch({"operation": "parameters.set", "args": {"changes": [{"parameter_id": handle, "expression": "20 mm"}]},
                                        "document_id": self.document_id, "expected_state": expected, "request_id": "x"})
        self.assert_error(result, "STALE_STATE")
        self.assertFalse(self.env.design.batch_calls)

    def test_read_only_configuration_is_not_confused_with_configured_master(self):
        self.env.design.isConfiguration = True
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "READ_ONLY_CONFIGURATION")
        self.assertFalse(self.env.design.batch_calls)

    def test_configuration_switch_invalidates_selections(self):
        row1 = NS(id="row-one", name="Small")
        row2 = NS(id="row-two", name="Large")
        self.env.design.isConfiguredDesign = True
        table = NS(id="master-table", activeRow=row1, rows=Collection([row1, row2]))
        self.env.design.configurationTopTable = table
        handle = self.handle(self.env.param)
        table.activeRow = row2
        result = self.call("parameters.set", {"changes": [{"parameter_id": handle, "expression": "20 mm"}]})
        self.assert_error(result, "STALE_ENTITY")

    def test_split_face_tokens_are_not_resolved_by_first_match(self):
        body = self.add_body()
        face = Face(body)
        self.env.design.tokens[face.entityToken] = [face]
        handle = self.handle(face)
        self.env.design.tokens[face.entityToken] = [face, Face(body, "face-two")]
        with self.assertRaises(self.runtime.FusionError) as raised:
            self.runtime._resolve(self.ctx, handle, ("adsk::fusion::BRepFace",))
        self.assertEqual(raised.exception.code, "AMBIGUOUS_ENTITY")

    def test_changed_token_string_for_same_object_does_not_change_identity(self):
        handle = self.handle(self.env.param)
        self.env.param.entityToken = "new-token-for-same-object"
        self.env.design.tokens[self.env.param.entityToken] = [self.env.param]
        self.assertEqual(self.handle(self.env.param), handle)
        self.assertIs(self.runtime._resolve(self.ctx, handle), self.env.param)

    def test_stale_body_revision_requires_reinspection(self):
        body = self.add_body()
        handle = self.handle(body)
        body.revisionId = "changed"
        with self.assertRaises(self.runtime.FusionError) as raised:
            self.runtime._resolve(self.ctx, handle)
        self.assertEqual(raised.exception.code, "STALE_ENTITY")
        self.handle(body)  # Explicit rediscovery refreshes the observation.
        self.assertIs(self.runtime._resolve(self.ctx, handle), body)

    def test_parameter_batch_false_is_none_not_partial(self):
        self.env.design.batch_accept = False
        original = self.env.param.expression
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "PARAMETER_BATCH_REJECTED")
        self.assertEqual(self.env.param.expression, original)

    def test_parameter_batch_exception_is_unknown_and_not_retried(self):
        self.env.design.batch_exception = True
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "API_ERROR", "unknown")
        self.assertEqual(len(self.env.design.batch_calls), 1)

    def test_parameter_batch_uses_value_input_expressions_and_internal_units(self):
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "1 in"}]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.env.design.batch_calls[0][1][0].expression, "1 in")
        self.assertAlmostEqual(self.env.param.value, 2.54)

    def test_ambiguous_numeric_dimensions_rejected(self):
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "25"}]})
        self.assert_error(result, "UNITS_REQUIRED")
        self.assertFalse(self.env.design.batch_calls)

    def test_wrong_physical_dimension_is_rejected(self):
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "30 deg"}]})
        self.assert_error(result, "INVALID_EXPRESSION")

    def test_dimensionless_parameter_can_use_numeric_expression(self):
        result = self.call("parameters.add", {"name": "Count", "expression": "6", "unit": ""})
        self.assertTrue(result["ok"], result)

    def test_nonactive_document_mutation_does_not_steal_active_tab(self):
        other = Document(self.env.app, Design())
        self.env.app.documents.items.append(other)
        self.env.app.activeDocument = other
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "DOCUMENT_NOT_ACTIVE")
        self.assertIs(self.env.app.activeDocument, other)

    def test_close_refuses_unsaved_edits_and_never_implicit_saves(self):
        self.env.doc.isModified = True
        result = self.call("documents.close", {"discard_unsaved": False})
        self.assert_error(result, "UNSAVED_CHANGES")
        self.assertFalse(self.env.doc.close_calls)
        self.assertFalse(self.env.doc.save_calls)

    def test_close_clean_document_uses_false_save_flag(self):
        result = self.call("documents.close", {"discard_unsaved": False})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.env.doc.close_calls, [False])

    def test_limit_truncation_is_visible(self):
        self.env.design.add_parameter("Width", NS(expression="10 mm"), "mm", "")
        result = self.call("parameters.list", {"limit": 1})
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["truncated"])
        self.assertEqual(result["data"]["total"], 2)

    def test_face_discovery_requires_parent_body(self):
        result = self.call("entities.find", {"kind": "face"})
        self.assert_error(result, "PARENT_REQUIRED")

    def test_sketch_bounds_are_explicitly_in_sketch_space(self):
        sketch = self.add_sketch()
        line = sketch.sketchCurves.sketchLines.addByTwoPoints(Point(), Point(1, 2, 0))
        line.boundingBox = NS(minPoint=Point(), maxPoint=Point(1, 2, 0))
        result = self.call("geometry.measure", {"kind": "bounding_box", "entity_ids": [self.handle(line)]})
        self.assertTrue(result["ok"], result)
        observation = result["data"]["measurements"][0]
        self.assertEqual(observation["bounding_box"]["frame"]["kind"], "sketch")
        self.assertEqual(observation["bounding_box"]["frame"]["sketch_id"], self.handle(sketch))
        self.assertEqual(observation["entity"]["frame"], "sketch")

    def test_physical_measurement_separates_scalar_units_from_coordinate_frame(self):
        body = self.add_body()
        result = self.call("geometry.measure", {"kind": "physical", "entity_ids": [self.handle(body)], "accuracy": "high"})
        self.assertTrue(result["ok"], result)
        observation = result["data"]["measurements"][0]
        self.assertEqual(observation["mass"]["unit"], "kg")
        self.assertEqual(observation["volume"]["unit"], "cm^3")
        self.assertEqual(observation["density"]["unit"], "kg/cm^3")
        self.assertEqual(observation["center_of_mass"]["frame"]["kind"], "component")

    def test_occurrence_mass_does_not_imply_a_qualified_global_center(self):
        occurrence = Occurrence(self.env.design.rootComponent)
        result = self.call("geometry.measure", {"kind": "physical", "entity_ids": [self.handle(occurrence)]})
        self.assertTrue(result["ok"], result)
        observation = result["data"]["measurements"][0]
        self.assertEqual(observation["mass"]["value"], 0.0027)
        self.assertFalse(observation["center_of_mass"]["frame"]["qualified"])

    def test_angle_measurement_retains_all_three_positions_and_distinct_units(self):
        first = self.env.design.rootComponent.xConstructionAxis
        second = self.env.design.rootComponent.yConstructionAxis
        calls = []
        def measure_angle(a, b):
            calls.append((a, b))
            return NS(value=math.pi / 2, positionOne=Point(1, 0, 0), positionTwo=Point(), positionThree=Point(0, 1, 0))
        self.env.app.measureManager = NS(measureAngle=measure_angle)
        result = self.call("geometry.measure", {"kind": "angle", "entity_ids": [self.handle(first), self.handle(second)]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(calls, [(first, second)])
        self.assertEqual(result["data"]["unit"], "rad")
        self.assertEqual(result["data"]["position_unit"], "cm")
        self.assertEqual(result["data"]["position_three"], [0, 1, 0])

    def test_interference_inspection_never_creates_model_bodies_or_recomputes(self):
        first, second = self.add_body(), self.add_body()
        self.env.design.createInterferenceInput = lambda entities: NS(entities=entities)
        interference = Collection([NS(entityOne=first, entityTwo=second, interferenceBody=NS(volume=0.5))])
        interference.createBodies = lambda: self.fail("Read-only analysis must not create model bodies")
        self.env.design.analyzeInterference = lambda input_obj: interference
        self.env.design.computeAll = lambda: self.fail("Read-only analysis must not recompute the design")
        result = self.call("geometry.check", {"kind": "interference", "entity_ids": [self.handle(first), self.handle(second)]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["effects"], [])
        self.assertEqual(self.env.design.rootComponent.bRepBodies.count, 2)
        self.assertEqual(result["data"]["interferences"][0]["volume"], {"value": 0.5, "unit": "cm^3"})

    def test_interference_cannot_infer_placement_of_native_child_component_body(self):
        child = Component(self.env.design, "child-definition")
        self.env.design.allComponents.items.append(child)
        root_body, child_body = self.add_body(), Body(child)
        child.bRepBodies.items.append(child_body)
        self.env.design.createInterferenceInput = lambda _: self.fail("Ambiguous placement must fail before analysis")
        result = self.call("geometry.check", {"kind": "interference", "entity_ids": [self.handle(root_body), self.handle(child_body)]})
        self.assert_error(result, "UNSUPPORTED_CONTEXT")

    def test_sketch_batch_prevalidates_all_curves_before_mutating(self):
        sketch = self.add_sketch()
        result = self.call("sketches.draw", {"sketch_id": self.handle(sketch), "frame": "sketch", "curves": [
            {"kind": "line", "start": ["0 mm", "0 mm"], "end": ["10 mm", "0 mm"]},
            {"kind": "rectangle", "corner1": ["0 mm", "0 mm"], "corner2": ["0 mm", "10 mm"]}]})
        self.assert_error(result, "INVALID_GEOMETRY")
        self.assertEqual(sketch.sketchCurves.calls, 0)

    def test_sketch_partial_failure_reports_completed_effects(self):
        sketch = self.add_sketch()
        sketch.sketchCurves.fail_on = 2
        result = self.call("sketches.draw", {"sketch_id": self.handle(sketch), "frame": "sketch", "curves": [
            {"kind": "line", "start": ["0 mm", "0 mm"], "end": ["10 mm", "0 mm"]},
            {"kind": "line", "start": ["10 mm", "0 mm"], "end": ["10 mm", "10 mm"]}]})
        self.assert_error(result, "API_ERROR", "partial")
        self.assertEqual(sketch.sketchCurves.count, 1)
        self.assertTrue(result["error"]["details"]["effects"])

    def test_rectangle_returns_selectable_profile_and_line_points(self):
        sketch = self.add_sketch()
        result = self.call("sketches.draw", {"sketch_id": self.handle(sketch), "frame": "sketch", "curves": [
            {"kind": "rectangle", "corner1": ["0 mm", "0 mm"], "corner2": ["20 mm", "10 mm"]}]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["data"]["profiles"]), 1)
        self.assertEqual(len(result["data"]["curves"]), 4)
        self.assertIn("start_point_id", result["data"]["curves"][0])

    def test_extrude_requires_explicit_participants_for_cut(self):
        sketch = self.add_sketch()
        profile = Object("adsk::fusion::Profile", parentSketch=sketch)
        result = self.call("features.extrude", {"profile_ids": [self.handle(profile)], "distance": "5 mm", "operation": "cut"})
        self.assert_error(result, "PARTICIPANTS_REQUIRED")
        self.assertFalse(self.env.design.rootComponent.features.extrudeFeatures.inputs)

    def test_extrude_uses_current_extent_definition_without_direct_mode_conversion(self):
        self.add_body()
        sketch = self.add_sketch()
        profile = Object("adsk::fusion::Profile", parentSketch=sketch)
        result = self.call("features.extrude", {"profile_ids": [self.handle(profile)], "distance": "5 mm", "operation": "new_body"})
        self.assertTrue(result["ok"], result)
        inp = self.env.design.rootComponent.features.extrudeFeatures.inputs[0]
        self.assertEqual(inp.extent.distance.expression, "5 mm")
        self.assertEqual(inp.direction, 1)
        self.assertEqual(self.env.design.designType, 1)

    def test_fillet_and_chamfer_use_released_modern_inputs(self):
        body = self.add_body()
        edge = Object("adsk::fusion::BRepEdge", body=body)
        handle = self.handle(edge)
        result = self.call("features.fillet", {"edge_ids": [handle], "radius": "1 mm"})
        self.assertTrue(result["ok"], result)
        self.assertFalse(self.env.design.rootComponent.features.filletFeatures.inputs[0].tangent)
        result = self.call("features.chamfer", {"edge_ids": [handle], "distance": "1 mm"})
        self.assertTrue(result["ok"], result)
        self.assertTrue(self.env.design.rootComponent.features.chamferFeatures.used_create_input2)

    def test_feature_authoring_never_converts_direct_design(self):
        self.env.design.designType = 0
        result = self.call("features.fillet", {"edge_ids": ["unused"], "radius": "1 mm"})
        self.assert_error(result, "UNSUPPORTED_DESIGN_TYPE")
        self.assertEqual(self.env.design.designType, 0)

    def test_transform_converts_only_row_major_translation_units(self):
        numbers = [0, -1, 0, 25.4, 1, 0, 0, 50.8, 0, 0, 1, -25.4, 0, 0, 0, 1]
        matrix = self.runtime._transform({"frame": "parent", "matrix": numbers, "translation_unit": "mm"})
        self.assertEqual(matrix.asArray()[1], -1)
        self.assertAlmostEqual(matrix.asArray()[3], 2.54)
        self.assertAlmostEqual(matrix.asArray()[7], 5.08)
        self.assertAlmostEqual(matrix.asArray()[11], -2.54)

    def test_transform_rejects_scale_shear_and_reflection(self):
        for numbers in ([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                        [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]):
            with self.assertRaises(self.runtime.FusionError):
                self.runtime._transform({"frame": "parent", "matrix": numbers, "translation_unit": "cm"})

    def test_occurrence_transform_uses_exact_parent_membership_and_local_translation(self):
        child = Component(self.env.design, "placed-child")
        self.env.design.allComponents.items.append(child)
        occurrence = Occurrence(child)
        self.env.design.rootComponent.occurrences.items.append(occurrence)
        self.env.design.rootComponent.allOccurrences.items.append(occurrence)
        matrix = Matrix().asArray()
        matrix[3] = 25.4
        result = self.call("components.transform", {"occurrence_id": self.handle(occurrence),
                           "transform": {"frame": "parent", "matrix": matrix, "translation_unit": "mm"}})
        self.assertTrue(result["ok"], result)
        self.assertAlmostEqual(occurrence.transform2.asArray()[3], 2.54)
        self.assertEqual(result["data"]["transform"]["frame"], "parent")

    def test_occurrence_transform_cannot_edit_a_referenced_source_parent(self):
        source = Design()
        foreign_parent = source.rootComponent
        self.env.design.allComponents.items.append(foreign_parent)
        occurrence = Occurrence(Component(source, "source-child"))
        foreign_parent.occurrences.items.append(occurrence)
        original = occurrence.transform2.asArray()
        result = self.call("components.transform", {"occurrence_id": self.handle(occurrence),
                           "transform": {"frame": "parent", "matrix": Matrix().asArray(), "translation_unit": "cm"}})
        self.assert_error(result, "EXTERNAL_REFERENCE_READ_ONLY")
        self.assertEqual(occurrence.transform2.asArray(), original)

    def test_stl_export_sets_units_and_never_launches_print_utility(self):
        self.add_body()
        result = self.call("exports.generate", {"format": "stl", "output_path": str(self.directory / "model.stl"), "unit": "in", "mesh_refinement": "high"})
        self.assertTrue(result["ok"], result)
        options = self.env.design.exportManager.options
        self.assertFalse(options.sendToPrintUtility)
        self.assertFalse(options.isOneFilePerBody)
        self.assertTrue(options.isBinaryFormat)
        self.assertEqual(options.unitType, 3)
        self.assertEqual(result["data"]["artifact"]["unit"], "in")

    def test_export_cannot_overwrite_existing_file(self):
        output = self.directory / "existing.step"
        output.write_text("important file")
        result = self.call("exports.generate", {"format": "step", "output_path": str(output)})
        self.assert_error(result, "OUTPUT_EXISTS")
        self.assertEqual(output.read_text(), "important file")
        self.assertEqual(self.env.design.exportManager.execute_calls, 0)

    def test_symlink_parent_and_hardlinked_input_rejected(self):
        real = self.directory / "real"
        real.mkdir()
        link = self.directory / "link"
        link.symlink_to(real, target_is_directory=True)
        result = self.call("exports.generate", {"format": "step", "output_path": str(link / "output.step")})
        self.assert_error(result, "UNSAFE_PATH")
        source = self.directory / "source.cps"
        target = self.directory / "hardlink.cps"
        source.write_text("approved")
        os.link(source, target)
        with self.assertRaises(self.runtime.FusionError) as raised:
            self.runtime._approved_file(str(target), hashlib.sha256(source.read_bytes()).hexdigest(), (".cps",))
        self.assertEqual(raised.exception.code, "UNSAFE_PATH")

    def test_f3d_is_not_claimed_as_external_assembly_package(self):
        occurrence = Occurrence(self.env.design.rootComponent)
        occurrence.isReferencedComponent = True
        self.env.design.rootComponent.allOccurrences.items.append(occurrence)
        result = self.call("exports.generate", {"format": "f3d", "output_path": str(self.directory / "model.f3d")})
        self.assert_error(result, "ASSEMBLY_ARCHIVE_REQUIRED")

    def test_render_has_nonempty_local_path_dimensions_and_restores_settings(self):
        renderer = self.env.design.renderManager.rendering
        result = self.call("render.start", {"output_path": str(self.directory / "render.png"), "width": 640, "height": 480, "quality": "excellent"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(renderer.calls, [(str(self.directory / "render.png"), 640, 480, 100)])
        self.assertEqual((renderer.aspectRatio, renderer.resolutionWidth, renderer.resolutionHeight, renderer.renderQuality), (0, 1080, 720, 75))
        self.assertFalse(result["data"]["cancel_supported"])
        self.assertFalse(result["data"]["cloud_destination"])

    def test_render_future_completion_does_not_mask_missing_output(self):
        result = self.call("render.start", {"output_path": str(self.directory / "render.png"), "width": 640, "height": 480, "quality": "draft"})
        self.env.design.renderManager.rendering.future.renderState = 2
        result = self.call("render.status", {"job_id": result["data"]["job_id"]})
        self.assertFalse(result["ok"], result)

    def test_cam_completed_future_requires_actual_valid_toolpaths(self):
        self.env.enable_cam()
        result = self.call("cam.generate", {"operation_ids": [self.handle(self.env.cam.operation)]})
        self.assertTrue(result["ok"], result)
        self.env.cam.future.isGenerationCompleted = True
        self.env.cam.future.numberOfCompleted = 1
        self.env.cam.operation.isToolpathValid = False
        result = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["status"], "failed")

    def test_cam_entitlement_denial_precedes_generation(self):
        self.env.enable_cam()
        self.env.cam.setup.operations.compatibleStrategies[0].isGenerationAllowed = False
        result = self.call("cam.generate", {"operation_ids": [self.handle(self.env.cam.operation)]})
        self.assert_error(result, "ENTITLEMENT_REQUIRED")
        self.assertEqual(self.env.cam.generate_calls, 0)

    def test_cam_choice_matches_value_not_localized_label(self):
        parameters = Collection([CamParameter("direction", "Choice", "climb", ["climb", "conventional"])])
        self.runtime._apply_cam_parameters(self.ctx, parameters, [{"name": "direction", "type": "choice", "value": "conventional"}])
        self.assertEqual(parameters.item(0).value.value, "conventional")
        with self.assertRaises(self.runtime.FusionError):
            self.runtime._apply_cam_parameters(self.ctx, parameters, [{"name": "direction", "type": "choice", "value": "Localized climb"}])

    def test_cam_safety_parameters_and_user_overrides_must_be_explicit(self):
        parameters = Collection([CamParameter("tool_feedCutting", "Float", 5), CamParameter("direction", "Choice", "climb", ["climb"])])
        parameters.item(1).expression = "user_override"
        with self.assertRaises(self.runtime.FusionError) as raised:
            self.runtime._validate_cam_defaults(parameters, set())
        self.assertEqual(raised.exception.code, "EXPLICIT_CAM_INPUTS_REQUIRED")
        self.assertIn("tool_feedCutting", raised.exception.details["missing_safety_parameters"])
        self.assertIn("direction", raised.exception.details["unreviewed_default_overrides"])

    def test_cam_schema_is_transient_and_does_not_create_operation(self):
        self.env.enable_cam()
        result = self.call("cam.operation_schema", {"setup_id": self.handle(self.env.cam.setup), "strategy": "face"})
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["data"]["created_operation"])
        self.assertEqual(self.env.cam.setup.input_calls, 1)
        self.assertEqual(self.env.cam.setup.add_calls, 0)

    def test_nc_post_explicit_safety_controls_override_preference_resets(self):
        args = self.nc_args()
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        program = self.env.cam.program
        options = program.post_calls[0]
        self.assertEqual(options.postProcessExecutionBehavior, 2)
        self.assertTrue(options.isFailOnToolNumberDuplication)
        self.assertEqual(options.fusionHubExecutionBehavior, 3)
        self.assertFalse(program.parameters.itemByName("nc_program_postToFusionTeam").value.value)
        self.assertFalse(program.parameters.itemByName("nc_program_openInEditor").value.value)
        self.assertFalse(program.parameters.itemByName("nc_program_orderByTool").value.value)
        self.assertEqual(result["data"]["release_state"], "quarantined_candidate")
        self.assertFalse(result["data"]["physical_release"])
        self.assertEqual(result["data"]["status"], "succeeded")
        self.assertEqual(len(result["data"]["artifacts"]), 1)

    def test_nc_duplicate_tool_number_rejected_before_program_creation(self):
        args = self.nc_args()
        second = Operation(self.env.cam.setup, 2, Tool(number=1, tool_id="different-tool"))
        self.env.cam.setup.allOperations.items.append(second)
        args["operation_ids"].append(self.handle(second))
        args["verification"]["source_state"] = self.state()
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "DUPLICATE_TOOL_NUMBER")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nc_invalid_toolpath_rejected_without_omission(self):
        args = self.nc_args()
        self.env.cam.operation.isToolpathValid = False
        args["verification"]["source_state"] = self.state()
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "INVALID_TOOLPATH")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nc_order_mismatch_leaves_candidate_but_does_not_post(self):
        args = self.nc_args()
        second = Operation(self.env.cam.setup, 2, Tool(number=2))
        self.env.cam.setup.allOperations.items.append(second)
        args["operation_ids"].append(self.handle(second))
        args["verification"]["source_state"] = self.state()
        self.env.cam.reverse_order = True
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "NC_OPERATION_ORDER_MISMATCH", "partial")
        self.assertEqual(self.env.cam.program.post_calls, [])

    def test_nc_profile_hash_change_rejected_before_program_creation(self):
        args = self.nc_args()
        Path(args["post_config_path"]).write_text("unapproved changed executable post")
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "PROFILE_CHANGED")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nc_non_equivalent_machine_rejected(self):
        args = self.nc_args()
        approved = Machine()
        approved.definition_version = 2
        self.env.library_manager.machineLibrary.machineAtURL = lambda url: approved
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "MACHINE_PROFILE_CHANGED")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_machine_definition_edit_changes_state_even_with_same_machine_id(self):
        self.env.enable_cam()
        before = self.state()
        self.env.cam.machine.definition_version += 1
        self.assertNotEqual(self.state(), before)

    def test_camera_changes_are_part_of_document_freshness(self):
        before = self.state()
        self.env.app.activeViewport.camera.eye.x += 1
        self.assertNotEqual(self.state(), before)

    def test_cam_geometry_selection_change_is_detected_without_expression_change(self):
        self.env.enable_cam()
        body1, body2 = self.add_body(), self.add_body()
        selection = CamParameter("model", "CadObject", [body1])
        selection.expression = ""
        self.env.cam.operation.parameters.items.append(selection)
        before = self.state()
        selection.value.value = [body2]
        self.assertNotEqual(self.state(), before)

    def test_state_observation_does_not_refresh_old_entity_selection(self):
        self.env.enable_cam()
        body = self.add_body()
        handle = self.handle(body)
        self.env.cam.setup.models = [body]
        body.revisionId = "changed"
        self.state()
        with self.assertRaises(self.runtime.FusionError) as raised:
            self.runtime._resolve(self.ctx, handle)
        self.assertEqual(raised.exception.code, "STALE_ENTITY")

    def test_unqualified_complex_cam_state_blocks_effects(self):
        self.env.enable_cam()
        complex_value = CamParameter("complexSelection", "UnknownComplex", None)
        self.env.cam.operation.parameters.items.append(complex_value)
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")
        self.assertFalse(self.env.design.batch_calls)

    def test_external_reference_version_change_is_freshness_relevant(self):
        occurrence = Occurrence(self.env.design.rootComponent)
        occurrence.isReferencedComponent = True
        self.env.design.rootComponent.allOccurrences.items.append(occurrence)
        before = self.state()
        occurrence.documentReference.dataFile.versionId = "source-version-2"
        occurrence.documentReference.version = 2
        self.assertNotEqual(self.state(), before)

    def test_active_background_job_blocks_mutation_without_killing_fusion(self):
        self.env.app.hasActiveJobs = True
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "20 mm"}]})
        self.assert_error(result, "FUSION_BUSY")
        self.assertFalse(self.env.design.batch_calls)

    def test_nc_stale_verification_record_rejected(self):
        args = self.nc_args()
        args["verification"]["source_state"] = "old-source"
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "VERIFICATION_STALE")

    def test_nc_background_completion_is_polled_not_assumed(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["status"], "validating")
        job_id = result["data"]["job_id"]
        running = self.call("cam.status", {"job_id": job_id})
        self.assertEqual(running["data"]["status"], "validating")
        self.env.app.hasActiveJobs = False
        completed = self.call("cam.status", {"job_id": job_id})
        self.assertTrue(completed["ok"], completed)
        self.assertEqual(completed["data"]["status"], "succeeded")
        self.assertFalse(completed["data"]["physical_release"])

    def test_nc_source_change_during_export_cannot_be_released(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.env.app.hasActiveJobs = False
        self.env.param.expression = "100 mm"
        status = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assert_error(status, "POST_SOURCE_CHANGED", "unknown")

    def test_nc_control_change_during_background_post_invalidates_candidate(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        source_state = self.state()
        self.env.cam.program.parameters.itemByName("nc_program_openInEditor").value.value = True
        self.assertEqual(self.state(), source_state, "Source toolpaths alone must not stand in for candidate controls")
        self.env.app.hasActiveJobs = False
        status = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assert_error(status, "POST_PROGRAM_CHANGED", "unknown")
        self.assertEqual(len(self.env.cam.program.post_calls), 1)

    def test_nc_post_parameter_change_during_background_post_invalidates_candidate(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        self.env.cam.program.postParameters.items.append(CamParameter("useG28", "Boolean", True))
        self.env.app.hasActiveJobs = False
        status = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assert_error(status, "POST_PROGRAM_CHANGED", "unknown")

    def test_nc_profile_bytes_cannot_change_while_background_post_is_pending(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        Path(args["post_config_path"]).write_text("// Synthetic source changed during posting")
        self.env.app.hasActiveJobs = False
        status = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assert_error(status, "POST_PROFILE_CHANGED", "unknown")

    def test_bom_keeps_occurrence_quantity_separate_from_unknown_overrides(self):
        first, second = Occurrence(self.env.design.rootComponent, "Part:1"), Occurrence(self.env.design.rootComponent, "Part:2")
        self.env.design.rootComponent.occurrences.items.extend([first, second])
        self.env.design.rootComponent.allOccurrences.items.extend([first, second])
        result = self.call("bom.inspect")
        self.assertTrue(result["ok"], result)
        rows = result["data"]["rows"]
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["occurrence_id"], rows[1]["occurrence_id"])
        self.assertEqual(rows[0]["component_id"], rows[1]["component_id"])
        self.assertEqual(rows[0]["quantity"]["value"], 1)
        self.assertIsNone(rows[0]["bom_quantity_override"])
        self.assertIsNone(rows[0]["suppressed"])
        self.assertFalse(result["data"]["normalization_complete"])

    def test_all_handlers_have_official_source_mapping(self):
        self.assertEqual(set(self.runtime._HANDLERS), set(self.runtime.SOURCE_MEMBERS))
        self.assertGreaterEqual(len(self.runtime._HANDLERS), 49)

    def test_nc_tool_must_match_complete_approved_library_definition(self):
        args = self.nc_args()
        self.env.cam.operation.tool.tool_id = "different-same-number"
        args["verification"]["source_state"] = self.state()
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "TOOL_LIBRARY_MISMATCH")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nc_changed_holder_fails_even_with_same_tool_id_and_number(self):
        args = self.nc_args()
        self.env.cam.operation.tool.holder = {"description": "Changed holder", "segments": [{"height": 80}]}
        args["verification"]["source_state"] = self.state()
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "TOOL_LIBRARY_MISMATCH")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nc_tool_library_file_hash_is_enforced(self):
        args = self.nc_args()
        Path(args["tool_library"]["source_path"]).write_text('{"data":[]}')
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "PROFILE_CHANGED")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_tool_listing_hash_filter_returns_exact_complete_json(self):
        args = self.nc_args()
        listed = self.call("cam.tools_list", {"tool_library": args["tool_library"], "limit": 1})
        self.assertTrue(listed["ok"], listed)
        self.assertEqual(listed["data"]["next_offset"], 1)
        selected = listed["data"]["tools"][0]
        self.assertNotIn("tool_json", selected)
        self.assertIsNotNone(selected["holder_sha256"])
        exact = self.call("cam.tools_list", {"tool_library": args["tool_library"], "tool_sha256": selected["definition_sha256"]})
        self.assertTrue(exact["ok"], exact)
        self.assertEqual(json.loads(exact["data"]["tools"][0]["tool_json"]), json.loads(Tool().toJson()))
        self.assertFalse(exact["data"]["shared_library_modified"])

    def test_machining_time_forwards_explicit_percent_cm_per_second_and_seconds(self):
        self.env.enable_cam()
        calls = []
        def estimate(operations, percent, rapid, change):
            calls.append((operations, percent, rapid, change))
            return NS(machiningTime=100, totalFeedTime=80, totalRapidTime=10, totalToolChangeTime=10,
                      feedDistance=120, rapidDistance=300, toolChangeCount=2)
        self.env.cam.getMachiningTime = estimate
        result = self.call("cam.machining_time", {"operation_ids": [self.handle(self.env.cam.operation)],
                          "feed_scale_percent": 80, "rapid_feed_cm_per_second": 30, "tool_change_seconds": 5})
        self.assertTrue(result["ok"], result)
        self.assertEqual(calls[0][1:], (80, 30, 5))
        self.assertEqual(result["data"]["machining_time"], {"value": 100, "unit": "s"})
        self.assertTrue(result["data"]["estimated"])
        self.assertEqual(result["effects"], [])

    def test_setup_sheet_handles_nested_assets_without_opening_external_app(self):
        self.env.enable_cam()
        output = self.directory / "setup_sheets"
        output.mkdir(mode=0o700)
        calls = []
        def generate(operations, format_value, folder, open_document):
            calls.append((operations, format_value, folder, open_document))
            path = Path(folder)
            (path / "setup.html").write_text("<html>Offline contract setup sheet</html>")
            (path / "images").mkdir()
            (path / "images" / "preview.png").write_bytes(b"fake image")
            return True
        self.env.cam.generateSetupSheet = generate
        result = self.call("cam.setup_sheet", {"operation_ids": [self.handle(self.env.cam.operation)], "format": "html", "output_folder": str(output)})
        self.assertTrue(result["ok"], result)
        self.assertFalse(calls[0][3])
        self.assertEqual(len(result["data"]["artifacts"]), 2)
        self.assertFalse(result["data"]["physical_release"])

    def test_setup_sheet_rejects_generated_symlink_assets(self):
        self.env.enable_cam()
        output = self.directory / "setup_sheets"
        output.mkdir(mode=0o700)
        secret = self.directory / "unapproved.txt"
        secret.write_text("Do not include")
        def generate(operations, format_value, folder, open_document):
            (Path(folder) / "setup.html").write_text("<html>Synthetic</html>")
            (Path(folder) / "linked.txt").symlink_to(secret)
            return True
        self.env.cam.generateSetupSheet = generate
        result = self.call("cam.setup_sheet", {"operation_ids": [self.handle(self.env.cam.operation)], "format": "html", "output_folder": str(output)})
        self.assert_error(result, "UNSAFE_PATH", "partial")

    def test_import_creates_new_document_and_never_claims_parser_isolation(self):
        for format_name, extension in (("step", ".step"), ("f3d", ".f3d")):
            with self.subTest(format=format_name):
                source = self.directory / ("input" + extension)
                source.write_bytes(b"Synthetic trusted import source")
                result = self.call("documents.import", {"format": format_name, "source_path": str(source),
                                   "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "input_trust": "approved_trusted"}, document=False)
                self.assertTrue(result["ok"], result)
                self.assertNotEqual(result["data"]["document"]["document_id"], self.document_id)
                self.assertFalse(result["data"]["cloud_save_requested"])
                self.assertEqual(result["data"]["isolation"], "shared_fusion_process")
                self.assertFalse(self.env.app.importManager.calls[-1].isViewFit)

    def test_untrusted_input_cannot_use_shared_process_import(self):
        result = self.call("documents.import", {"format": "step", "source_path": str(self.directory / "input.step"),
                           "source_sha256": "0" * 64, "input_trust": "untrusted"}, document=False)
        self.assert_error(result, "ISOLATED_IMPORT_REQUIRED")
        self.assertEqual(self.env.app.importManager.calls, [])

    def test_session_import_cannot_smuggle_existing_document_target(self):
        result = self.call("documents.import", {"format": "step", "source_path": str(self.directory / "input.step"),
                           "source_sha256": "0" * 64, "input_trust": "approved_trusted"})
        self.assert_error(result, "INVALID_ARGUMENT")

    def test_sketch_constraint_batch_is_typed_and_operates_on_exact_entities(self):
        sketch = self.add_sketch()
        first = sketch.sketchCurves.addByTwoPoints(Point(), Point(1, 0, 0))
        second = sketch.sketchCurves.addByTwoPoints(Point(0, 1, 0), Point(1, 1, 0))
        result = self.call("sketches.constrain", {"sketch_id": self.handle(sketch), "constraints": [
            {"kind": "horizontal", "entity_ids": [self.handle(first)]},
            {"kind": "parallel", "entity_ids": [self.handle(first), self.handle(second)]}]})
        self.assertTrue(result["ok"], result)
        self.assertEqual([call[0] for call in sketch.geometricConstraints.calls], ["Horizontal", "Parallel"])
        self.assertIs(sketch.geometricConstraints.calls[1][1][1], second)

    def test_invalid_constraint_after_valid_one_is_rejected_before_first_edit(self):
        sketch = self.add_sketch()
        first = sketch.sketchCurves.addByTwoPoints(Point(), Point(1, 0, 0))
        point = first.startSketchPoint
        result = self.call("sketches.constrain", {"sketch_id": self.handle(sketch), "constraints": [
            {"kind": "horizontal", "entity_ids": [self.handle(first)]},
            {"kind": "concentric", "entity_ids": [self.handle(first), self.handle(point)]}]})
        self.assert_error(result, "WRONG_ENTITY_TYPE")
        self.assertEqual(sketch.geometricConstraints.calls, [])

    def test_direct_design_without_timeline_can_be_inspected_and_exported(self):
        self.env.design.designType = 0
        self.env.design.timeline = None
        inspected = self.call("document.inspect")
        self.assertTrue(inspected["ok"], inspected)
        self.assertIsNone(inspected["data"]["timeline"])
        result = self.call("exports.generate", {"format": "step", "output_path": str(self.directory / "direct.step")})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.env.design.designType, 0)

    def test_wrong_product_id_is_cast_and_rejected(self):
        self.env.design.objectType = "adsk::core::Product"
        result = self.call("parameters.list", expected=False)
        self.assert_error(result, "WRONG_PRODUCT")

    def test_same_material_id_density_change_invalidates_nc_review_before_post(self):
        args = self.nc_args()
        approved = self.state()
        material = self.env.design.rootComponent.material
        identity = material.id
        material.materialProperties.itemById("physical_density").value = 0.00785
        result = self.runtime.dispatch({"operation": "cam.nc_post", "args": args, "request_id": "material-drift",
                                        "document_id": self.document_id, "expected_state": approved})
        self.assertEqual(material.id, identity)
        self.assert_error(result, "STALE_STATE")
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_distinct_material_objects_with_same_id_do_not_share_cached_definition(self):
        body = self.add_body()
        body.material = Material(self.env.design.rootComponent.material.id)
        observed = self.state()
        body.material.materialProperties.itemById("yield_strength").value = 90.0
        self.assertNotEqual(self.state(), observed)
        self.assertEqual(self.env.design.rootComponent.material.materialProperties.itemById("yield_strength").value, 275.0)

    def test_material_fingerprint_covers_multiple_values_and_units(self):
        material = self.env.design.rootComponent.material
        stiffness = MaterialProperty("anisotropic_stiffness", "Float", 200.0, "GPa")
        stiffness.hasMultipleValues = True
        stiffness.values = [200.0, 150.0, 50.0]
        material.materialProperties.items.append(stiffness)
        initial = self.state()
        stiffness.values[1] = 125.0
        changed = self.state()
        self.assertNotEqual(changed, initial)
        self.assertEqual(stiffness.value, 200.0, "Scalar fallback did not capture the changed tensor value")
        stiffness.units = "MPa"
        self.assertNotEqual(self.state(), changed)

    def test_unqualified_physical_material_properties_block_nc_without_writing(self):
        args = self.nc_args()
        self.env.design.rootComponent.material.materialProperties.items.append(
            Object("adsk::core::UnreviewedEngineeringTableProperty", id="temperature_response"))
        args["verification"]["source_state"] = self.state()
        result = self.call("cam.nc_post", args)
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")
        self.assertTrue(any("engineering_material:unsupported_engineering_property_type" in gap for gap in result["error"]["details"]["gaps"]))
        self.assertEqual(self.env.cam.nc_add_calls, 0)

    def test_nonfinite_material_value_is_an_explicit_freshness_gap(self):
        self.env.design.rootComponent.material.materialProperties.itemById("physical_density").value = float("nan")
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "15 mm"}]})
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")
        self.assertFalse(self.env.design.batch_calls)

    def test_unqualified_visual_texture_does_not_block_cad_or_read_secret_contents(self):
        class SecretMaterial(Material):
            @property
            def appearance(self):
                raise AssertionError("Engineering freshness must not traverse appearance or texture content")

        class SecretTexture(Object):
            @property
            def value(self):
                raise AssertionError("Visual texture contents must not be read")

        material = SecretMaterial()
        material.materialProperties.items.append(SecretTexture("adsk::core::AppearanceTextureProperty", id="visual_normal_map"))
        self.env.design.rootComponent.material = material
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "15 mm"}]})
        self.assertTrue(result["ok"], result)
        self.assertNotIn("freshness_gaps", result["data"])
        self.assertIn("texture/image file contents", result["data"]["freshness_scope"]["excluded"])

    def test_external_material_file_is_not_read_or_silently_considered_fingerprinted(self):
        secret = "/private/unapproved/private-material-secret.csv"
        material = self.env.design.rootComponent.material
        material.materialProperties.items.append(MaterialProperty("tabulated_response", "Filename", secret))
        with patch.object(self.runtime, "_file_sha256", side_effect=AssertionError("Material provided files must not be opened")):
            result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "15 mm"}]})
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")
        self.assertTrue(any("external_material_file_not_fingerprinted" in gap for gap in result["error"]["details"]["gaps"]))
        self.assertNotIn(secret, json.dumps(result))

    def test_unreadable_engineering_material_value_is_a_reported_gap(self):
        class UnreadableFloat(Object):
            @property
            def value(self):
                raise RuntimeError("Synthetic provider property access failure")

        self.env.design.rootComponent.material.materialProperties.items.append(
            UnreadableFloat("adsk::core::FloatProperty", id="thermal_response", units="K", hasConnectedTexture=False, hasMultipleValues=False))
        inspection = self.call("document.inspect")
        self.assertTrue(inspection["ok"], inspection)
        self.assertTrue(any("engineering_material:property_value_unavailable" in gap for gap in inspection["data"]["freshness_gaps"]))
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "15 mm"}]})
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")

    def test_unexpected_numeric_material_texture_is_not_silently_excluded(self):
        density = self.env.design.rootComponent.material.materialProperties.itemById("physical_density")
        density.hasConnectedTexture = True
        result = self.call("parameters.set", {"changes": [{"parameter_id": self.handle(self.env.param), "expression": "15 mm"}]})
        self.assert_error(result, "FRESHNESS_UNAVAILABLE")
        self.assertTrue(any("numeric_material_texture_not_fingerprinted" in gap for gap in result["error"]["details"]["gaps"]))

    def test_material_list_returns_qualified_hash_and_assignment_verifies_definition(self):
        library, material = self.material_library()
        listing = self.call("materials.list", {"library_id": library.id})
        self.assertTrue(listing["ok"], listing)
        entry = listing["data"]["materials"][0]
        self.assertTrue(entry["qualified"])
        self.assertEqual(entry["property_count"], 3)
        self.assertRegex(entry["engineering_sha256"], "^[a-f0-9]{64}$")
        body = self.add_body()
        result = self.call("materials.assign", {"entity_id": self.handle(body), "library_id": library.id,
                                                "material_id": material.id, "expected_material_sha256": entry["engineering_sha256"]})
        self.assertTrue(result["ok"], result)
        self.assertIs(body.material, material)
        self.assertEqual(result["data"]["engineering_sha256"], entry["engineering_sha256"])
        self.assertTrue(result["data"]["definition_verified"])

    def test_material_library_drift_is_rejected_even_when_document_state_is_unchanged(self):
        library, material = self.material_library()
        listing = self.call("materials.list", {"library_id": library.id})
        digest = listing["data"]["materials"][0]["engineering_sha256"]
        body = self.add_body()
        original = body.material
        document_state = self.state()
        material.materialProperties.itemById("yield_strength").value = 999.0
        self.assertEqual(self.state(), document_state)
        result = self.call("materials.assign", {"entity_id": self.handle(body), "library_id": library.id,
                                                "material_id": material.id, "expected_material_sha256": digest})
        self.assert_error(result, "MATERIAL_DEFINITION_CHANGED")
        self.assertIs(body.material, original)

    def test_material_library_definition_is_rechecked_after_document_guard(self):
        library, material = self.material_library()
        digest = self.call("materials.list", {"library_id": library.id})["data"]["materials"][0]["engineering_sha256"]
        body = self.add_body()
        original_material = body.material
        original_before = self.runtime._Context.before
        def change_after_guard(ctx, *args, **kwargs):
            original_before(ctx, *args, **kwargs)
            material.materialProperties.itemById("physical_density").value = 123.0
        with patch.object(self.runtime._Context, "before", change_after_guard):
            result = self.call("materials.assign", {"entity_id": self.handle(body), "library_id": library.id,
                                                    "material_id": material.id, "expected_material_sha256": digest})
        self.assert_error(result, "MATERIAL_DEFINITION_CHANGED")
        self.assertIs(body.material, original_material)

    def test_material_assignment_accepts_a_document_copy_with_different_material_id(self):
        class CopyingBody(Body):
            @property
            def material(self):
                return self._material

            @material.setter
            def material(self, value):
                self._material = copy.deepcopy(value)
                self._material.id = "document-local-material-copy"

        library, material = self.material_library()
        digest = self.call("materials.list", {"library_id": library.id})["data"]["materials"][0]["engineering_sha256"]
        body = CopyingBody(self.env.design.rootComponent)
        body.material = self.env.design.rootComponent.material
        self.env.design.rootComponent.bRepBodies.items.append(body)
        result = self.call("materials.assign", {"entity_id": self.handle(body), "library_id": library.id,
                                                "material_id": material.id, "expected_material_sha256": digest})
        self.assertTrue(result["ok"], result)
        self.assertNotEqual(result["data"]["assigned_material_id"], material.id)
        self.assertEqual(result["data"]["engineering_sha256"], digest)

    def test_material_assignment_checks_actual_values_and_reports_failed_postcondition(self):
        class RejectingBody(Body):
            @property
            def material(self):
                return self._material

            @material.setter
            def material(self, value):
                if value.id != "approved-library-material":
                    self._material = value

        library, material = self.material_library()
        digest = self.call("materials.list", {"library_id": library.id})["data"]["materials"][0]["engineering_sha256"]
        body = RejectingBody(self.env.design.rootComponent)
        body.material = self.env.design.rootComponent.material
        self.env.design.rootComponent.bRepBodies.items.append(body)
        result = self.call("materials.assign", {"entity_id": self.handle(body), "library_id": library.id,
                                                "material_id": material.id, "expected_material_sha256": digest})
        self.assert_error(result, "MATERIAL_DEFINITION_CHANGED", "partial")
        self.assertIs(body.material, self.env.design.rootComponent.material)

    def test_same_id_material_drift_invalidates_an_asynchronous_nc_candidate(self):
        args = self.nc_args()
        self.env.cam.background_post = True
        result = self.call("cam.nc_post", args)
        self.assertTrue(result["ok"], result)
        self.env.design.rootComponent.material.materialProperties.itemById("physical_density").value = 0.02
        self.env.app.hasActiveJobs = False
        status = self.call("cam.status", {"job_id": result["data"]["job_id"]})
        self.assert_error(status, "POST_SOURCE_CHANGED", "unknown")

    def test_read_state_token_rejects_mixed_version_pagination(self):
        observed = self.state()
        self.env.param.expression = "20 mm"
        result = self.runtime.dispatch({"operation": "parameters.list", "args": {"limit": 1},
                                        "request_id": "next-page", "document_id": self.document_id,
                                        "expected_state": observed})
        self.assert_error(result, "STALE_STATE")
        fresh = self.call("parameters.list", {"limit": 1}, expected=False)
        self.assertTrue(fresh["ok"], fresh)
        self.assertNotEqual(fresh["state"], observed)

    def test_oversized_request_is_rejected_before_autodesk_access(self):
        with patch.object(self.runtime, "_api", side_effect=AssertionError("Autodesk must not be accessed")):
            result = self.runtime.dispatch({"operation": "documents.create", "request_id": "oversized",
                                            "args": {"name": "x" * (self.runtime._MAX_REQUEST_BYTES + 1)}})
        self.assert_error(result, "LIMIT_EXCEEDED")

    def test_nonfinite_request_is_rejected_before_autodesk_access(self):
        with patch.object(self.runtime, "_api", side_effect=AssertionError("Autodesk must not be accessed")):
            result = self.runtime.dispatch({"operation": "documents.list", "request_id": "nonfinite",
                                            "args": {"limit": float("nan")}})
        self.assert_error(result, "INVALID_ARGUMENT")

    def test_result_limit_never_masks_a_completed_mutation_as_no_change(self):
        parameter = self.handle(self.env.param)
        with patch.object(self.runtime, "_MAX_RESPONSE_BYTES", 1):
            result = self.call("parameters.set", {"changes": [{"parameter_id": parameter, "expression": "25 mm"}]})
        self.assert_error(result, "LIMIT_EXCEEDED", "partial")
        self.assertEqual(self.env.param.expression, "25 mm")
        self.assertEqual(len(self.env.design.batch_calls), 1)
        self.assertTrue(result["error"]["details"]["effects"])

    def test_render_job_survives_render_settings_restoration_failure(self):
        class FailingRestore(Rendering):
            def __setattr__(self, name, value):
                if name == "resolutionWidth" and value == 1080 and getattr(self, "calls", []):
                    raise RuntimeError("Synthetic failure restoring prior width")
                super().__setattr__(name, value)

        self.env.design.renderManager.rendering = FailingRestore()
        result = self.call("render.start", {"output_path": str(self.directory / "recoverable.png"),
                                             "width": 400, "height": 300, "quality": "standard"})
        self.assert_error(result, "RENDER_SETTINGS_RESTORE_FAILED", "partial")
        job_id = result["error"]["details"]["cause"]["job_id"]
        self.assertIn(job_id, self.runtime._JOBS)
        status = self.call("render.status", {"job_id": job_id})
        self.assertTrue(status["ok"], status)
        self.assertEqual(status["data"]["status"], "queued")


class LiveFusionQualification(unittest.TestCase):
    @unittest.skip("Unavailable: this host has no Autodesk Fusion installation, licensed session, or native endpoint. API-double tests do not validate CAD kernels or manufacturing safety.")
    def test_live_fusion_main_thread_kernel_cam_and_artifact_qualification(self):
        pass


if __name__ == "__main__":
    unittest.main()
