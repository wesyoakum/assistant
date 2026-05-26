import ExpoModulesCore
import ARKit
import SceneKit
import UIKit
import simd

// A React Native native view backed by ARSCNView. ARKit owns the camera
// feed + world tracking + plane detection. We expose imperative methods
// to add anchors via raycast and to render SceneKit spheres on them.
public final class LidarARView: ExpoView, ARSCNViewDelegate {
  let sceneView = ARSCNView(frame: .zero)
  private var nextBallNumber: Int = 1
  // anchor id → assigned ball number (so the label stays stable across frames)
  private var ballNumbers: [UUID: Int] = [:]

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
    config.planeDetection = [.horizontal]
    sceneView.session.run(config, options: [])
  }

  // MARK: - Imperative methods

  /// Raycast from a screen point (normalized to the view's bounds) and
  /// add an ARAnchor at the first hit on the estimated floor plane.
  /// Returns the anchor's world position + assigned ball number.
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

  /// Returns the current set of ball anchors with their tracked world positions.
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
    // Sort by ball number for stable display
    out.sort { (($0["number"] as? Int) ?? 0) < (($1["number"] as? Int) ?? 0) }
    return out
  }

  /// Remove a single ball anchor by id.
  func removeBall(id: String) {
    guard let frame = sceneView.session.currentFrame,
          let uuid = UUID(uuidString: id) else { return }
    for anchor in frame.anchors where anchor.identifier == uuid {
      sceneView.session.remove(anchor: anchor)
      ballNumbers.removeValue(forKey: anchor.identifier)
    }
  }

  /// Remove all ball anchors.
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

  /// Returns the current camera-to-world transform (16 floats, column-major).
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

  // MARK: - ARSCNViewDelegate — render a sphere at each ball anchor

  public func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
    guard let name = anchor.name, name.hasPrefix("ball-") else { return }

    // Parse the embedded radius hint (default 3 cm)
    var radius: CGFloat = 0.03
    if let rRange = name.range(of: "-r"), let val = Double(name[rRange.upperBound...]) {
      radius = CGFloat(val)
    }

    let sphere = SCNSphere(radius: radius)
    sphere.firstMaterial?.diffuse.contents = UIColor.systemYellow
    sphere.firstMaterial?.emission.contents = UIColor.systemYellow.withAlphaComponent(0.3)
    let sphereNode = SCNNode(geometry: sphere)
    sphereNode.position = SCNVector3(0, Float(radius), 0)  // sit on the plane
    node.addChildNode(sphereNode)

    // Numbered label floating above the ball
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
}
