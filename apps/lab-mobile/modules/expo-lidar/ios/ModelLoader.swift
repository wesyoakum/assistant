import SceneKit
import Foundation

/// Downloads and caches .usdz models from a remote URL.
/// Models are cached in the app's Caches directory.
/// Usage: ModelLoader.shared.loadModel(kind: "home_plate") { node in ... }
final class ModelLoader {
  static let shared = ModelLoader()

  private var baseURL: String = "https://lab.whyapp.us/models"
  private let cache = NSCache<NSString, SCNNode>()
  private let fileManager = FileManager.default
  private var cacheDir: URL {
    let dir = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ar-models", isDirectory: true)
    try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  func setBaseURL(_ url: String) {
    baseURL = url.hasSuffix("/") ? String(url.dropLast()) : url
  }

  /// Attempt to load a .usdz model for the given kind.
  /// Returns an SCNNode clone if available (from memory cache, disk cache, or download).
  /// Returns nil if no model is available (caller should use fallback geometry).
  func loadModel(kind: String, completion: @escaping (SCNNode?) -> Void) {
    // Normalize kind: strip dynamic suffixes (e.g., "foul_line_1b-60.9" → "foul_line_1b")
    let normalizedKind = kind.split(separator: "-").first.map(String.init) ?? kind

    // Check memory cache
    if let cached = cache.object(forKey: normalizedKind as NSString) {
      completion(cached.clone())
      return
    }

    // Check disk cache
    let localURL = cacheDir.appendingPathComponent("\(normalizedKind).usdz")
    if fileManager.fileExists(atPath: localURL.path) {
      if let node = loadFromFile(localURL, kind: normalizedKind) {
        completion(node.clone())
        return
      }
    }

    // Download from remote
    let remoteURLString = "\(baseURL)/\(normalizedKind).usdz"
    guard let remoteURL = URL(string: remoteURLString) else {
      completion(nil)
      return
    }

    URLSession.shared.downloadTask(with: remoteURL) { [weak self] tempURL, response, error in
      guard let self = self,
            let tempURL = tempURL,
            let httpResponse = response as? HTTPURLResponse,
            httpResponse.statusCode == 200 else {
        DispatchQueue.main.async { completion(nil) }
        return
      }

      // Move to cache directory
      try? self.fileManager.removeItem(at: localURL)
      try? self.fileManager.moveItem(at: tempURL, to: localURL)

      DispatchQueue.main.async {
        if let node = self.loadFromFile(localURL, kind: normalizedKind) {
          completion(node.clone())
        } else {
          completion(nil)
        }
      }
    }.resume()
  }

  /// Pre-fetch a list of model kinds (download in background).
  func prefetch(kinds: [String]) {
    for kind in kinds {
      loadModel(kind: kind) { _ in /* just cache it */ }
    }
  }

  /// Clear all cached models (memory + disk).
  func clearCache() {
    cache.removeAllObjects()
    try? fileManager.removeItem(at: cacheDir)
  }

  private func loadFromFile(_ url: URL, kind: String) -> SCNNode? {
    guard let scene = try? SCNScene(url: url, options: [
      .checkConsistency: true,
      .convertToYUp: true,
    ]) else { return nil }

    let containerNode = SCNNode()
    for child in scene.rootNode.childNodes {
      containerNode.addChildNode(child.clone())
    }

    // Cache in memory
    cache.setObject(containerNode, forKey: kind as NSString)
    return containerNode
  }
}

// Convenience extension for cloning
extension SCNNode {
  func deepClone() -> SCNNode {
    return clone()
  }
}
