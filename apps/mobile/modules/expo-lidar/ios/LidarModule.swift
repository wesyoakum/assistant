import ExpoModulesCore
import ARKit
import UIKit
import CoreGraphics

public final class LidarModule: Module {
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
  let maxMeters: Float = 5.0

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

    let srcW = CVPixelBufferGetWidth(pb)
    let srcH = CVPixelBufferGetHeight(pb)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
    guard let baseAddr = CVPixelBufferGetBaseAddress(pb) else { return }
    let stride = bytesPerRow / MemoryLayout<Float32>.size
    let base = baseAddr.assumingMemoryBound(to: Float32.self)

    // Sample to the requested gridW × gridH (landscape).
    var depths = [Float](repeating: 0, count: gridW * gridH)
    var minV: Float = .greatestFiniteMagnitude
    var maxV: Float = 0
    for gy in 0..<gridH {
      let srcY = Int(Double(gy) / Double(gridH) * Double(srcH))
      for gx in 0..<gridW {
        let srcX = Int(Double(gx) / Double(gridW) * Double(srcW))
        let d = base[srcY * stride + srcX]
        depths[gy * gridW + gx] = d
        if d > 0 && d < minV { minV = d }
        if d > maxV { maxV = d }
      }
    }
    if minV == .greatestFiniteMagnitude { minV = 0 }

    // Rotate 90° CW into an RGBA buffer for portrait viewing.
    // Output dimensions: (gridH × gridW).
    let outW = gridH
    let outH = gridW
    var rgba = [UInt8](repeating: 0, count: outW * outH * 4)
    for gy in 0..<gridH {
      for gx in 0..<gridW {
        let d = depths[gy * gridW + gx]
        let (r, g, b) = colorize(depth: d, maxMeters: maxMeters)
        // 90° CW: (gx, gy) → (outX, outY) = (gridH - 1 - gy, gx)
        let outX = gridH - 1 - gy
        let outY = gx
        let i = (outY * outW + outX) * 4
        rgba[i + 0] = r
        rgba[i + 1] = g
        rgba[i + 2] = b
        rgba[i + 3] = 255
      }
    }

    guard let pngData = makePng(rgba: rgba, width: outW, height: outH) else { return }
    let base64 = pngData.base64EncodedString()

    onPayload([
      "width": outW,
      "height": outH,
      "minMeters": minV,
      "maxMeters": maxV,
      "imageBase64": base64
    ])
  }
}

private func colorize(depth: Float, maxMeters: Float) -> (UInt8, UInt8, UInt8) {
  if depth <= 0 { return (0, 0, 0) }
  let norm = min(1.0, Double(depth) / Double(maxMeters))
  let hue = norm * 260.0
  return hslToRgb(h: hue, s: 0.8, l: 0.5)
}

private func hslToRgb(h: Double, s: Double, l: Double) -> (UInt8, UInt8, UInt8) {
  let c = (1.0 - abs(2.0 * l - 1.0)) * s
  let hp = h / 60.0
  let x = c * (1.0 - abs(hp.truncatingRemainder(dividingBy: 2.0) - 1.0))
  var r: Double = 0, g: Double = 0, b: Double = 0
  switch hp {
  case 0..<1: (r, g, b) = (c, x, 0)
  case 1..<2: (r, g, b) = (x, c, 0)
  case 2..<3: (r, g, b) = (0, c, x)
  case 3..<4: (r, g, b) = (0, x, c)
  case 4..<5: (r, g, b) = (x, 0, c)
  default:    (r, g, b) = (c, 0, x)
  }
  let m = l - c / 2.0
  return (
    UInt8(min(255, max(0, ((r + m) * 255.0).rounded()))),
    UInt8(min(255, max(0, ((g + m) * 255.0).rounded()))),
    UInt8(min(255, max(0, ((b + m) * 255.0).rounded())))
  )
}

private func makePng(rgba: [UInt8], width: Int, height: Int) -> Data? {
  let bytesPerRow = width * 4
  let data = Data(rgba)
  guard let provider = CGDataProvider(data: data as CFData) else { return nil }
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo: CGBitmapInfo = [
    CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
  ]
  guard let cgImage = CGImage(
    width: width,
    height: height,
    bitsPerComponent: 8,
    bitsPerPixel: 32,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: bitmapInfo,
    provider: provider,
    decode: nil,
    shouldInterpolate: false,
    intent: .defaultIntent
  ) else { return nil }
  return UIImage(cgImage: cgImage).pngData()
}
