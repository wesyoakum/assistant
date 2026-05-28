import ExpoModulesCore
import ARKit
import SceneKit
import UIKit
import simd

// A React Native native view backed by ARSCNView. ARKit owns the camera
// feed + world tracking + plane detection + scene reconstruction. We
// expose imperative methods to add anchors via raycast and render
// SceneKit markers, plus props to toggle ARKit visualizations.
public final class LidarARView: ExpoView, ARSCNViewDelegate {
  let sceneView = ARSCNView(frame: .zero)
  private var nextBallNumber: Int = 1
  // anchor id → assigned ball number (so the label stays stable across frames)
  private var ballNumbers: [UUID: Int] = [:]
  // Strong reference to every ball ARAnchor we've created. We can't trust
  // sceneView.session.currentFrame.anchors for lookups because that snapshot
  // doesn't include just-added anchors until the next frame is captured,
  // which causes remove/list to silently no-op and leak spheres into the
  // scene.
  private var ballAnchors: [UUID: ARAnchor] = [:]
  // Color state requested for an anchor before its SCNNode existed. Applied
  // when renderer:didAdd:for: creates the sphere.
  private var pendingBallStates: [UUID: String] = [:]

  // Visualization toggles (set via Expo Modules view props).
  public var showPlanesProp: Bool = false {
    didSet { if showPlanesProp != oldValue { refreshPlaneViz() } }
  }
  public var showMeshProp: Bool = false {
    didSet { if showMeshProp != oldValue { refreshMeshViz() } }
  }
  public var showFeaturePointsProp: Bool = false {
    didSet { sceneView.debugOptions = showFeaturePointsProp ? [.showFeaturePoints] : [] }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    sceneView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(sceneView)
    NSLayoutConstraint.activate([
      sceneView.topAnchor.constraint(equalTo: topAnchor),
      sceneView.bottomAnchor.constraint(equalTo: bottomAnchor),
      sceneView.leadingAnchor.constraint(equalTo: leadingAnchor),
      sceneView.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])

    sceneView.delegate = self
    sceneView.automaticallyUpdatesLighting = true
    sceneView.autoenablesDefaultLighting = true
    sceneView.scene = SCNScene()

    runSession()
  }

  override public func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      runSession()
    } else {
      sceneView.session.pause()
    }
  }

  private func runSession() {
    guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
      return
    }
    let config = ARWorldTrackingConfiguration()
    config.frameSemantics = .sceneDepth
    // Detect both. Toggles control whether we *render* them, not detection.
    config.planeDetection = [.horizontal, .vertical]
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
      config.sceneReconstruction = .mesh
    }
    sceneView.session.run(config, options: [])
  }

  // MARK: - Imperative methods (balls)

  /// Raycast from a screen point (normalized to the view's bounds) and
  /// add an ARAnchor at the first hit on the estimated floor plane.
  func addBallAtScreenPoint(nx: CGFloat, ny: CGFloat, radius: Float) -> [String: Any]? {
    let pt = CGPoint(x: nx * bounds.width, y: ny * bounds.height)
    guard let query = sceneView.raycastQuery(
      from: pt,
      allowing: .estimatedPlane,
      alignment: .horizontal
    ) else { return nil }
    let results = sceneView.session.raycast(query)
    guard let hit = results.first else { return nil }
    let xform = hit.worldTransform
    let number = nextBallNumber
    nextBallNumber += 1
    let anchor = ARAnchor(name: "ball-\(number)-r\(radius)", transform: xform)
    sceneView.session.add(anchor: anchor)
    ballNumbers[anchor.identifier] = number
    ballAnchors[anchor.identifier] = anchor
    return [
      "id": anchor.identifier.uuidString,
      "number": number,
      "worldX": xform.columns.3.x,
      "worldY": xform.columns.3.y,
      "worldZ": xform.columns.3.z,
    ]
  }

  func listBalls() -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (uuid, anchor) in ballAnchors {
      let number = ballNumbers[uuid] ?? 0
      out.append([
        "id": uuid.uuidString,
        "number": number,
        "worldX": anchor.transform.columns.3.x,
        "worldY": anchor.transform.columns.3.y,
        "worldZ": anchor.transform.columns.3.z,
      ])
    }
    out.sort { (($0["number"] as? Int) ?? 0) < (($1["number"] as? Int) ?? 0) }
    return out
  }

  func removeBall(id: String) {
    guard let uuid = UUID(uuidString: id),
          let anchor = ballAnchors[uuid] else { return }
    sceneView.session.remove(anchor: anchor)
    ballAnchors.removeValue(forKey: uuid)
    ballNumbers.removeValue(forKey: uuid)
    pendingBallStates.removeValue(forKey: uuid)
  }

  func clearBalls() {
    for (_, anchor) in ballAnchors {
      sceneView.session.remove(anchor: anchor)
    }
    ballAnchors.removeAll()
    ballNumbers.removeAll()
    pendingBallStates.removeAll()
    nextBallNumber = 1
  }

  /// Wipe ARKit's world map + every anchor (planes, mesh, balls) and re-run the
  /// session from scratch. Used by the "Reset AR" button.
  func resetSession() {
    let config = ARWorldTrackingConfiguration()
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      config.frameSemantics = .sceneDepth
    }
    config.planeDetection = [.horizontal, .vertical]
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
      config.sceneReconstruction = .mesh
    }
    sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    ballAnchors.removeAll()
    ballNumbers.removeAll()
    pendingBallStates.removeAll()
    nextBallNumber = 1
    fieldLandmarks.removeAll()
    fieldLandmarkKinds.removeAll()
    fieldLandmarkRotations.removeAll()
  }

  /// Project a world point onto the view. Returns screen coordinates
  /// normalized to view bounds (0–1) + whether the point is in front of the
  /// camera. Used by JS revalidation to check "is this ball in the camera
  /// view right now?".
  func projectWorldPoint(_ x: Float, _ y: Float, _ z: Float) -> [String: Any]? {
    let projected = sceneView.projectPoint(SCNVector3(x, y, z))
    let w = bounds.width > 0 ? bounds.width : 1
    let h = bounds.height > 0 ? bounds.height : 1
    return [
      "screenX": Double(projected.x) / Double(w),
      "screenY": Double(projected.y) / Double(h),
      // SceneKit returns z in normalized [0,1] (or outside if clipped). > 1
      // means behind the camera in the perspective transform.
      "isInFront": projected.z >= 0 && projected.z <= 1.0,
      "depth": Double(projected.z),
    ]
  }

  /// Update the rendered sphere color for one ball anchor based on its
  /// current state. JS owns the state machine; this is just visual feedback.
  ///
  /// May be called before the sphere has been rendered (the SCNNode is
  /// created in renderer:didAdd:for: on the next render frame). In that
  /// case we stash the desired state and apply it when the sphere appears.
  func setBallState(id: String, state: String) {
    guard let uuid = UUID(uuidString: id), ballAnchors[uuid] != nil else { return }
    pendingBallStates[uuid] = state
    if let anchor = ballAnchors[uuid],
       let node = sceneView.node(for: anchor),
       let sphereNode = node.childNode(withName: "ball-sphere", recursively: false),
       let sphere = sphereNode.geometry as? SCNSphere {
      applyBallColor(sphere: sphere, state: state)
    }
  }

  private func applyBallColor(sphere: SCNSphere, state: String) {
    let color = LidarARView.colorForBallState(state)
    sphere.firstMaterial?.diffuse.contents = color
    sphere.firstMaterial?.emission.contents = color.withAlphaComponent(0.3)
  }

  private static func colorForBallState(_ state: String) -> UIColor {
    switch state {
    case "probable":   return UIColor.systemCyan
    case "confirmed":  return UIColor(red: 1.0, green: 0.0, blue: 1.0, alpha: 1.0)  // fuchsia
    case "candidate":  fallthrough
    default:           return UIColor.systemYellow
    }
  }

  func currentCameraTransform() -> [Float]? {
    guard let frame = sceneView.session.currentFrame else { return nil }
    let xform = frame.camera.transform
    var arr: [Float] = []
    arr.reserveCapacity(16)
    for col in 0..<4 {
      let c = xform[col]
      arr.append(c.x); arr.append(c.y); arr.append(c.z); arr.append(c.w)
    }
    return arr
  }

  // MARK: - ARSCNViewDelegate

  public func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
    // Ball anchors: colored sphere + numbered label
    if let name = anchor.name, name.hasPrefix("ball-") {
      addBallViz(to: node, anchor: anchor, name: name)
      return
    }
    // Field landmark anchors: white geometry on the ground
    if let name = anchor.name, name.hasPrefix("field-") {
      let kind = String(name.dropFirst(6))  // drop "field-" prefix
      addFieldLandmarkViz(to: node, anchor: anchor, kind: kind)
      return
    }
    // Plane anchors: optionally render a colored quad
    if let planeAnchor = anchor as? ARPlaneAnchor, showPlanesProp {
      addPlaneViz(to: node, anchor: planeAnchor)
      return
    }
    // Mesh anchors: optionally render wireframe
    if #available(iOS 13.4, *), let meshAnchor = anchor as? ARMeshAnchor, showMeshProp {
      addMeshViz(to: node, anchor: meshAnchor)
      return
    }
  }

  public func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
    if let planeAnchor = anchor as? ARPlaneAnchor {
      updatePlaneViz(node: node, anchor: planeAnchor)
    }
    if #available(iOS 13.4, *), let meshAnchor = anchor as? ARMeshAnchor {
      updateMeshViz(node: node, anchor: meshAnchor)
    }
  }

  // MARK: - Ball viz

  private func addBallViz(to node: SCNNode, anchor: ARAnchor, name: String) {
    var radius: CGFloat = 0.03
    if let rRange = name.range(of: "-r"), let val = Double(name[rRange.upperBound...]) {
      radius = CGFloat(val)
    }
    let sphere = SCNSphere(radius: radius)
    // Apply any state JS already requested before the sphere existed.
    let initialState = pendingBallStates[anchor.identifier] ?? "candidate"
    applyBallColor(sphere: sphere, state: initialState)
    let sphereNode = SCNNode(geometry: sphere)
    sphereNode.name = "ball-sphere"
    sphereNode.position = SCNVector3(0, Float(radius), 0)
    node.addChildNode(sphereNode)

    if let num = ballNumbers[anchor.identifier] {
      let text = SCNText(string: "#\(num)", extrusionDepth: 0)
      text.font = UIFont.boldSystemFont(ofSize: 1)
      text.firstMaterial?.diffuse.contents = UIColor.white
      text.firstMaterial?.isDoubleSided = true
      let textNode = SCNNode(geometry: text)
      textNode.scale = SCNVector3(0.04, 0.04, 0.04)
      let (min, max) = text.boundingBox
      textNode.pivot = SCNMatrix4MakeTranslation((min.x + max.x) / 2, (min.y + max.y) / 2, 0)
      textNode.position = SCNVector3(0, Float(radius) * 4 + 0.05, 0)
      let billboard = SCNBillboardConstraint()
      billboard.freeAxes = [.Y]
      textNode.constraints = [billboard]
      node.addChildNode(textNode)
    }
  }

  // MARK: - Imperative methods (field landmarks)

  private var fieldLandmarks: [UUID: ARAnchor] = [:]
  private var fieldLandmarkKinds: [UUID: String] = [:]
  private var fieldLandmarkRotations: [UUID: Float] = [:]  // Y-axis rotation in degrees

  /// Raycast from a normalized screen point to the estimated floor plane.
  /// Returns the world position without creating any anchor.
  func raycastScreenPoint(nx: CGFloat, ny: CGFloat) -> [String: Any]? {
    let pt = CGPoint(x: nx * bounds.width, y: ny * bounds.height)
    guard let query = sceneView.raycastQuery(from: pt, allowing: .estimatedPlane, alignment: .horizontal) else { return nil }
    let results = sceneView.session.raycast(query)
    guard let hit = results.first else { return nil }
    let xform = hit.worldTransform
    return [
      "worldX": xform.columns.3.x,
      "worldY": xform.columns.3.y,
      "worldZ": xform.columns.3.z,
    ]
  }

  /// Place a field landmark (home plate, base, or rubber) at a screen point.
  func addFieldLandmark(nx: CGFloat, ny: CGFloat, kind: String) -> [String: Any]? {
    let pt = CGPoint(x: nx * bounds.width, y: ny * bounds.height)
    guard let query = sceneView.raycastQuery(from: pt, allowing: .estimatedPlane, alignment: .horizontal) else { return nil }
    let results = sceneView.session.raycast(query)
    guard let hit = results.first else { return nil }
    let xform = hit.worldTransform
    return addFieldLandmarkWithTransform(xform, kind: kind)
  }

  /// Place a field landmark directly at a world position (no raycast needed).
  func addFieldLandmarkAtWorld(x: Float, y: Float, z: Float, kind: String) -> [String: Any] {
    var xform = simd_float4x4(1) // identity
    xform.columns.3 = simd_float4(x, y, z, 1)
    return addFieldLandmarkWithTransform(xform, kind: kind)
  }

  private func addFieldLandmarkWithTransform(_ xform: simd_float4x4, kind: String) -> [String: Any] {
    let anchor = ARAnchor(name: "field-\(kind)", transform: xform)
    sceneView.session.add(anchor: anchor)
    fieldLandmarks[anchor.identifier] = anchor
    fieldLandmarkKinds[anchor.identifier] = kind
    fieldLandmarkRotations[anchor.identifier] = 0
    return [
      "id": anchor.identifier.uuidString,
      "kind": kind,
      "worldX": xform.columns.3.x,
      "worldY": xform.columns.3.y,
      "worldZ": xform.columns.3.z,
    ]
  }

  /// Move an existing field landmark to a new screen point (re-raycasts to ground).
  func moveFieldLandmark(id: String, nx: CGFloat, ny: CGFloat) -> [String: Any]? {
    guard let uuid = UUID(uuidString: id),
          let oldAnchor = fieldLandmarks[uuid],
          let kind = fieldLandmarkKinds[uuid] else { return nil }
    let pt = CGPoint(x: nx * bounds.width, y: ny * bounds.height)
    guard let query = sceneView.raycastQuery(from: pt, allowing: .estimatedPlane, alignment: .horizontal) else { return nil }
    let results = sceneView.session.raycast(query)
    guard let hit = results.first else { return nil }

    // Remove old anchor and create new one at updated position
    sceneView.session.remove(anchor: oldAnchor)
    let rotation = fieldLandmarkRotations[uuid] ?? 0
    var xform = hit.worldTransform
    // Apply stored Y rotation
    if rotation != 0 {
      let rad = rotation * .pi / 180.0
      let rotMatrix = simd_float4x4(
        simd_float4(cos(rad), 0, sin(rad), 0),
        simd_float4(0, 1, 0, 0),
        simd_float4(-sin(rad), 0, cos(rad), 0),
        simd_float4(0, 0, 0, 1)
      )
      let translation = xform.columns.3
      xform = simd_mul(xform, rotMatrix)
      xform.columns.3 = translation
    }
    let newAnchor = ARAnchor(name: "field-\(kind)", transform: xform)
    sceneView.session.add(anchor: newAnchor)

    // Transfer state from old UUID to new
    fieldLandmarks.removeValue(forKey: uuid)
    fieldLandmarkKinds.removeValue(forKey: uuid)
    let storedRotation = fieldLandmarkRotations.removeValue(forKey: uuid) ?? 0
    fieldLandmarks[newAnchor.identifier] = newAnchor
    fieldLandmarkKinds[newAnchor.identifier] = kind
    fieldLandmarkRotations[newAnchor.identifier] = storedRotation

    return [
      "id": newAnchor.identifier.uuidString,
      "kind": kind,
      "worldX": newAnchor.transform.columns.3.x,
      "worldY": newAnchor.transform.columns.3.y,
      "worldZ": newAnchor.transform.columns.3.z,
    ]
  }

  /// Rotate a field landmark around its Y axis by the given angle in degrees.
  func rotateFieldLandmark(id: String, angleDeg: Float) {
    guard let uuid = UUID(uuidString: id),
          let anchor = fieldLandmarks[uuid] else { return }
    fieldLandmarkRotations[uuid] = angleDeg
    // Update the visual node rotation
    if let node = sceneView.node(for: anchor),
       let vizNode = node.childNode(withName: "field-viz", recursively: false) {
      vizNode.eulerAngles.y = angleDeg * .pi / 180.0
    }
  }

  func removeFieldLandmark(id: String) {
    guard let uuid = UUID(uuidString: id),
          let anchor = fieldLandmarks[uuid] else { return }
    sceneView.session.remove(anchor: anchor)
    fieldLandmarks.removeValue(forKey: uuid)
    fieldLandmarkKinds.removeValue(forKey: uuid)
    fieldLandmarkRotations.removeValue(forKey: uuid)
  }

  func listFieldLandmarks() -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (uuid, anchor) in fieldLandmarks {
      let kind = fieldLandmarkKinds[uuid] ?? "unknown"
      out.append([
        "id": uuid.uuidString,
        "kind": kind,
        "worldX": anchor.transform.columns.3.x,
        "worldY": anchor.transform.columns.3.y,
        "worldZ": anchor.transform.columns.3.z,
      ])
    }
    return out
  }

  func clearFieldLandmarks() {
    for (_, anchor) in fieldLandmarks {
      sceneView.session.remove(anchor: anchor)
    }
    fieldLandmarks.removeAll()
    fieldLandmarkKinds.removeAll()
    fieldLandmarkRotations.removeAll()
  }

  // MARK: - Field landmark viz

  private func addFieldLandmarkViz(to node: SCNNode, anchor: ARAnchor, kind: String) {
    let vizNode = SCNNode()
    vizNode.name = "field-viz"

    // Foul poles are vertical cylinders — different rendering path
    if kind == "foul_pole_right" || kind == "foul_pole_left" {
      let geoNode = SCNNode(geometry: makeFoulPoleGeometry())
      geoNode.position = SCNVector3(0, 4.572, 0)  // half height (9.144m / 2)
      vizNode.addChildNode(geoNode)
    } else if kind.hasPrefix("outfield_wall") {
      // Extract radius from anchor name: "field-outfield_wall-<radius>"
      var radius: Float = 60.0
      if let name = anchor.name {
        let parts = name.split(separator: "-")
        if parts.count >= 3, let r = Float(parts.last!) {
          radius = r
        }
      }
      let wallNode = makeOutfieldWallGeometry(radiusM: radius)
      vizNode.addChildNode(wallNode)
    } else if kind == "foul_line_1b" || kind == "foul_line_3b" {
      // Foul lines: extract length from anchor name if encoded, else use 100m default
      var lineLength: Float = 100.0
      if let name = anchor.name {
        let parts = name.split(separator: "-")
        if parts.count >= 3, let len = Float(parts.last!) {
          lineLength = len
        }
      }
      let geoNode = SCNNode(geometry: makeFoulLineGeometry(lengthM: lineLength))
      geoNode.eulerAngles.x = -.pi / 2
      // Offset so the line starts at the anchor (home plate) and extends outward
      geoNode.position = SCNVector3(0, Float(lineLength) / 2.0, 0)
      vizNode.addChildNode(geoNode)
    } else {
      let geometry: SCNGeometry
      var useFlat = true  // whether to rotate -90° X to lay flat
      var yOffset: Float = 0  // lift above ground by half height for 3D geometry
      switch kind {
      case "home_plate":
        geometry = makeHomePlateGeometry()
        useFlat = false
        yOffset = 0  // SCNShape sits at origin, rotate to lay flat
      case "rubber":
        geometry = makeRubberGeometry()
        useFlat = false
        yOffset = 0.0254  // half of 2 inches
      case "batters_box_left", "batters_box_right":
        geometry = makeBattersBoxGeometry()
      default:  // first_base, second_base, third_base
        geometry = makeBaseGeometry()
        useFlat = false
        yOffset = 0.0254  // half of 2 inches
      }
      let geoNode = SCNNode(geometry: geometry)
      if useFlat {
        geoNode.eulerAngles.x = -.pi / 2  // lay flat on ground
      } else if kind == "home_plate" {
        // SCNShape extrudes along Z; rotate -90° X so extrusion goes up (Y)
        geoNode.eulerAngles.x = -.pi / 2
        geoNode.position.y = 0.0508 // extrusion depth = 2 inches
      } else {
        geoNode.position.y = yOffset
      }
      vizNode.addChildNode(geoNode)
    }

    // Apply stored rotation
    if let uuid = fieldLandmarks.first(where: { $0.value.identifier == anchor.identifier })?.key,
       let rotation = fieldLandmarkRotations[uuid], rotation != 0 {
      vizNode.eulerAngles.y = rotation * .pi / 180.0
    }

    // Floating label (only for main landmarks, not decorative elements)
    let labelText: String?
    switch kind {
    case "home_plate":      labelText = "HP"
    case "first_base":      labelText = "1B"
    case "second_base":     labelText = "2B"
    case "third_base":      labelText = "3B"
    case "rubber":          labelText = "R"
    case "foul_pole_right": labelText = "RF"
    case "foul_pole_left":  labelText = "LF"
    default:                labelText = nil
    }
    if let label = labelText {
      let text = SCNText(string: label, extrusionDepth: 0)
      text.font = UIFont.boldSystemFont(ofSize: 1)
      text.firstMaterial?.diffuse.contents = UIColor.white
      text.firstMaterial?.isDoubleSided = true
      let textNode = SCNNode(geometry: text)
      textNode.scale = SCNVector3(0.04, 0.04, 0.04)
      let (tMin, tMax) = text.boundingBox
      textNode.pivot = SCNMatrix4MakeTranslation((tMin.x + tMax.x) / 2, (tMin.y + tMax.y) / 2, 0)
      textNode.position = SCNVector3(0, kind.hasPrefix("foul_pole") ? 9.5 : 0.15, 0)
      let billboard = SCNBillboardConstraint()
      billboard.freeAxes = [.Y]
      textNode.constraints = [billboard]
      vizNode.addChildNode(textNode)
    }

    node.addChildNode(vizNode)
  }

  /// Home plate: white extruded pentagon, 17" wide, 2" tall.
  /// SCNShape extrudes along Z; we rotate so it sits flat with the pentagon shape on top.
  private func makeHomePlateGeometry() -> SCNGeometry {
    let w: CGFloat = 0.4318   // 17 inches
    let halfW = w / 2.0
    let frontDepth: CGFloat = 0.2159  // 8.5 inches (front triangle depth)
    let backDepth: CGFloat = 0.1524   // 6 inches (back rectangle depth)
    let height: CGFloat = 0.0508      // 2 inches tall

    // Pentagon path: tip at +Y (toward backstop after rotation)
    let path = UIBezierPath()
    path.move(to: CGPoint(x: 0, y: frontDepth))
    path.addLine(to: CGPoint(x: halfW, y: 0))
    path.addLine(to: CGPoint(x: halfW, y: -backDepth))
    path.addLine(to: CGPoint(x: -halfW, y: -backDepth))
    path.addLine(to: CGPoint(x: -halfW, y: 0))
    path.close()

    let shape = SCNShape(path: path, extrusionDepth: height)
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.white
    material.isDoubleSided = true
    shape.materials = [material]
    return shape
  }

  /// Base: white box, 15" × 15" × 2" tall.
  private func makeBaseGeometry() -> SCNGeometry {
    let size: CGFloat = 0.381  // 15 inches
    let h: CGFloat = 0.0508    // 2 inches tall
    let box = SCNBox(width: size, height: h, length: size, chamferRadius: 0)
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.white
    material.isDoubleSided = true
    box.materials = [material]
    return box
  }

  /// Rubber: white box, 24" × 6" × 2" tall.
  private func makeRubberGeometry() -> SCNGeometry {
    let w: CGFloat = 0.6096   // 24 inches
    let d: CGFloat = 0.1524   // 6 inches
    let h: CGFloat = 0.0508   // 2 inches tall
    let box = SCNBox(width: w, height: h, length: d, chamferRadius: 0)
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.white
    material.isDoubleSided = true
    box.materials = [material]
    return box
  }

  /// Batter's box: white semi-transparent rectangle, 4ft × 6ft (1.22m × 1.83m).
  private func makeBattersBoxGeometry() -> SCNGeometry {
    let w: CGFloat = 1.22   // 4 feet
    let h: CGFloat = 1.83   // 6 feet
    let plane = SCNPlane(width: w, height: h)
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.white.withAlphaComponent(0.3)
    material.isDoubleSided = true
    material.writesToDepthBuffer = false
    plane.materials = [material]
    return plane
  }

  /// Foul line: thin white plane on the ground, variable length.
  private func makeFoulLineGeometry(lengthM: Float) -> SCNGeometry {
    let plane = SCNPlane(width: 0.05, height: CGFloat(lengthM))  // 2 inches wide
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.white.withAlphaComponent(0.5)
    material.isDoubleSided = true
    material.writesToDepthBuffer = false
    plane.materials = [material]
    return plane
  }

  /// Foul pole: yellow cylinder, 8" (0.2032m) diameter, 30ft (9.144m) tall.
  private func makeFoulPoleGeometry() -> SCNGeometry {
    let cylinder = SCNCylinder(radius: 0.1016, height: 9.144)  // 4-inch radius, 30ft tall
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.systemYellow
    material.emission.contents = UIColor.systemYellow.withAlphaComponent(0.3)
    material.isDoubleSided = true
    cylinder.materials = [material]
    return cylinder
  }

  /// Outfield wall: dark green circular arc, 5ft (1.524m) tall, top 4" (0.1016m) yellow.
  /// The wall is built as a series of flat segments approximating the arc.
  /// The arc spans from the 1B foul line to the 3B foul line (180° around center field).
  /// Radius and arc center are encoded in the anchor name: "field-outfield_wall-<radius>".
  private func makeOutfieldWallGeometry(radiusM: Float) -> SCNNode {
    let wallHeight: Float = 1.524       // 5 feet
    let yellowCapHeight: Float = 0.1016 // 4 inches
    let greenHeight = wallHeight - yellowCapHeight
    let segments = 40
    let arcAngle: Float = .pi           // 180° arc
    let containerNode = SCNNode()

    for i in 0..<segments {
      let a1 = -arcAngle / 2 + arcAngle * Float(i) / Float(segments)
      let a2 = -arcAngle / 2 + arcAngle * Float(i + 1) / Float(segments)
      let segWidth = Float(radiusM) * (a2 - a1)

      // Green section
      let greenBox = SCNBox(width: CGFloat(segWidth), height: CGFloat(greenHeight), length: 0.05, chamferRadius: 0)
      let greenMat = SCNMaterial()
      greenMat.diffuse.contents = UIColor(red: 0.1, green: 0.3, blue: 0.1, alpha: 1.0)
      greenMat.isDoubleSided = true
      greenBox.materials = [greenMat]
      let greenNode = SCNNode(geometry: greenBox)

      // Yellow cap
      let yellowBox = SCNBox(width: CGFloat(segWidth), height: CGFloat(yellowCapHeight), length: 0.05, chamferRadius: 0)
      let yellowMat = SCNMaterial()
      yellowMat.diffuse.contents = UIColor.systemYellow
      yellowMat.isDoubleSided = true
      yellowBox.materials = [yellowMat]
      let yellowNode = SCNNode(geometry: yellowBox)
      yellowNode.position.y = (greenHeight + yellowCapHeight) / 2

      let segNode = SCNNode()
      segNode.addChildNode(greenNode)
      segNode.addChildNode(yellowNode)

      let midAngle = (a1 + a2) / 2
      segNode.position = SCNVector3(
        radiusM * sin(midAngle),
        greenHeight / 2,  // bottom on ground
        radiusM * cos(midAngle)
      )
      segNode.eulerAngles.y = midAngle

      containerNode.addChildNode(segNode)
    }
    return containerNode
  }

  // MARK: - Plane viz

  private func addPlaneViz(to node: SCNNode, anchor: ARPlaneAnchor) {
    let plane = SCNPlane(width: CGFloat(anchor.extent.x), height: CGFloat(anchor.extent.z))
    let isHoriz = anchor.alignment == .horizontal
    let color: UIColor = isHoriz ? .systemBlue : .systemPurple
    plane.firstMaterial?.diffuse.contents = color.withAlphaComponent(0.20)
    plane.firstMaterial?.isDoubleSided = true
    plane.firstMaterial?.writesToDepthBuffer = false
    let planeNode = SCNNode(geometry: plane)
    planeNode.position = SCNVector3(anchor.center.x, 0, anchor.center.z)
    planeNode.eulerAngles.x = -.pi / 2  // SCNPlane is vertical by default
    planeNode.name = "plane-viz"
    node.addChildNode(planeNode)
  }

  private func updatePlaneViz(node: SCNNode, anchor: ARPlaneAnchor) {
    if !showPlanesProp {
      node.childNode(withName: "plane-viz", recursively: false)?.removeFromParentNode()
      return
    }
    if let planeNode = node.childNode(withName: "plane-viz", recursively: false),
       let plane = planeNode.geometry as? SCNPlane {
      plane.width = CGFloat(anchor.extent.x)
      plane.height = CGFloat(anchor.extent.z)
      planeNode.position = SCNVector3(anchor.center.x, 0, anchor.center.z)
    } else {
      addPlaneViz(to: node, anchor: anchor)
    }
  }

  private func refreshPlaneViz() {
    guard let frame = sceneView.session.currentFrame else { return }
    for anchor in frame.anchors {
      guard let pa = anchor as? ARPlaneAnchor, let node = sceneView.node(for: pa) else { continue }
      node.childNode(withName: "plane-viz", recursively: false)?.removeFromParentNode()
      if showPlanesProp { addPlaneViz(to: node, anchor: pa) }
    }
  }

  // MARK: - Mesh viz (LiDAR scene reconstruction)

  @available(iOS 13.4, *)
  private func addMeshViz(to node: SCNNode, anchor: ARMeshAnchor) {
    let geo = makeWireframeGeometry(from: anchor.geometry)
    let meshNode = SCNNode(geometry: geo)
    meshNode.name = "mesh-viz"
    node.addChildNode(meshNode)
  }

  @available(iOS 13.4, *)
  private func updateMeshViz(node: SCNNode, anchor: ARMeshAnchor) {
    if !showMeshProp {
      node.childNode(withName: "mesh-viz", recursively: false)?.removeFromParentNode()
      return
    }
    if let meshNode = node.childNode(withName: "mesh-viz", recursively: false) {
      meshNode.geometry = makeWireframeGeometry(from: anchor.geometry)
    } else {
      addMeshViz(to: node, anchor: anchor)
    }
  }

  private func refreshMeshViz() {
    guard let frame = sceneView.session.currentFrame else { return }
    if #available(iOS 13.4, *) {
      for anchor in frame.anchors {
        guard let ma = anchor as? ARMeshAnchor, let node = sceneView.node(for: ma) else { continue }
        node.childNode(withName: "mesh-viz", recursively: false)?.removeFromParentNode()
        if showMeshProp { addMeshViz(to: node, anchor: ma) }
      }
    }
  }

  @available(iOS 13.4, *)
  private func makeWireframeGeometry(from mesh: ARMeshGeometry) -> SCNGeometry {
    let vertices = mesh.vertices
    let normals = mesh.normals
    let faces = mesh.faces

    let verticesSource = SCNGeometrySource(
      buffer: vertices.buffer,
      vertexFormat: vertices.format,
      semantic: .vertex,
      vertexCount: vertices.count,
      dataOffset: vertices.offset,
      dataStride: vertices.stride
    )
    let normalsSource = SCNGeometrySource(
      buffer: normals.buffer,
      vertexFormat: normals.format,
      semantic: .normal,
      vertexCount: normals.count,
      dataOffset: normals.offset,
      dataStride: normals.stride
    )
    let faceData = Data(
      bytesNoCopy: faces.buffer.contents(),
      count: faces.buffer.length,
      deallocator: .none
    )
    let element = SCNGeometryElement(
      data: faceData,
      primitiveType: .triangles,
      primitiveCount: faces.count,
      bytesPerIndex: faces.bytesPerIndex
    )

    let geometry = SCNGeometry(sources: [verticesSource, normalsSource], elements: [element])
    let material = SCNMaterial()
    material.diffuse.contents = UIColor.systemGreen.withAlphaComponent(0.7)
    material.fillMode = .lines
    material.isDoubleSided = true
    material.writesToDepthBuffer = false
    geometry.materials = [material]
    return geometry
  }
}
