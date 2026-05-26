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
    return [
      "id": anchor.identifier.uuidString,
      "number": number,
      "worldX": xform.columns.3.x,
      "worldY": xform.columns.3.y,
      "worldZ": xform.columns.3.z,
    ]
  }

  func listBalls() -> [[String: Any]] {
    guard let frame = sceneView.session.currentFrame else { return [] }
    var out: [[String: Any]] = []
    for anchor in frame.anchors {
      guard let name = anchor.name, name.hasPrefix("ball-") else { continue }
      let number = ballNumbers[anchor.identifier] ?? 0
      out.append([
        "id": anchor.identifier.uuidString,
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
    guard let frame = sceneView.session.currentFrame,
          let uuid = UUID(uuidString: id) else { return }
    for anchor in frame.anchors where anchor.identifier == uuid {
      sceneView.session.remove(anchor: anchor)
      ballNumbers.removeValue(forKey: anchor.identifier)
    }
  }

  func clearBalls() {
    guard let frame = sceneView.session.currentFrame else { return }
    for anchor in frame.anchors {
      if anchor.name?.hasPrefix("ball-") == true {
        sceneView.session.remove(anchor: anchor)
      }
    }
    ballNumbers.removeAll()
    nextBallNumber = 1
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
    // Ball anchors: yellow sphere + numbered label
    if let name = anchor.name, name.hasPrefix("ball-") {
      addBallViz(to: node, anchor: anchor, name: name)
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
    sphere.firstMaterial?.diffuse.contents = UIColor.systemYellow
    sphere.firstMaterial?.emission.contents = UIColor.systemYellow.withAlphaComponent(0.3)
    let sphereNode = SCNNode(geometry: sphere)
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
