import ExpoModulesCore
import ARKit

public class ExpoLidarModule: Module {
  private var arSession: ARSession?
  private var sessionDelegate: LidarSessionDelegate?

  public func definition() -> ModuleDefinition {
    Name("ExpoLidar")

    Events("onDepth")

    Function("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    AsyncFunction("startSession") { (gridW: Int, gridH: Int, throttleMs: Int) in
      guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
        throw LidarError.unsupported
      }
      let config = ARWorldTrackingConfiguration()
      config.frameSemantics = .sceneDepth

      let session = ARSession()
      let delegate = LidarSessionDelegate(
        gridW: gridW,
        gridH: gridH,
        minInterval: TimeInterval(throttleMs) / 1000.0
      ) { [weak self] payload in
        self?.sendEvent("onDepth", payload)
      }
      session.delegate = delegate
      session.run(config)

      DispatchQueue.main.async {
        self.arSession = session
        self.sessionDelegate = delegate
      }
    }

    AsyncFunction("stopSession") {
      DispatchQueue.main.async {
        self.arSession?.pause()
        self.arSession = nil
        self.sessionDelegate = nil
      }
    }
  }
}

enum LidarError: Error, LocalizedError {
  case unsupported
  var errorDescription: String? {
    switch self {
    case .unsupported:
      return "Device does not support ARKit scene depth (no LiDAR)."
    }
  }
}

class LidarSessionDelegate: NSObject, ARSessionDelegate {
  let gridW: Int
  let gridH: Int
  let minInterval: TimeInterval
  let onPayload: ([String: Any]) -> Void
  var lastFireAt: Date = Date.distantPast

  init(
    gridW: Int,
    gridH: Int,
    minInterval: TimeInterval,
    onPayload: @escaping ([String: Any]) -> Void
  ) {
    self.gridW = max(1, gridW)
    self.gridH = max(1, gridH)
    self.minInterval = minInterval
    self.onPayload = onPayload
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    let now = Date()
    if now.timeIntervalSince(lastFireAt) < minInterval { return }
    lastFireAt = now

    guard let sceneDepth = frame.sceneDepth else { return }
    let pb = sceneDepth.depthMap
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }

    let w = CVPixelBufferGetWidth(pb)
    let h = CVPixelBufferGetHeight(pb)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
    guard let baseAddr = CVPixelBufferGetBaseAddress(pb) else { return }
    let stride = bytesPerRow / MemoryLayout<Float32>.size

    var grid = [Float](repeating: 0, count: gridW * gridH)
    var minV: Float = .greatestFiniteMagnitude
    var maxV: Float = 0
    let base = baseAddr.assumingMemoryBound(to: Float32.self)
    for gy in 0..<gridH {
      let srcY = Int(Double(gy) / Double(gridH) * Double(h))
      for gx in 0..<gridW {
        let srcX = Int(Double(gx) / Double(gridW) * Double(w))
        let d = base[srcY * stride + srcX]
        grid[gy * gridW + gx] = d
        if d > 0 && d < minV { minV = d }
        if d > maxV { maxV = d }
      }
    }
    if minV == .greatestFiniteMagnitude { minV = 0 }

    onPayload([
      "width": gridW,
      "height": gridH,
      "minMeters": minV,
      "maxMeters": maxV,
      "depth": grid
    ])
  }
}
