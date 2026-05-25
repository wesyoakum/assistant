import ExpoModulesCore
import GameController

public final class GameControllerModule: Module {
  private var connectObserver: NSObjectProtocol?
  private var disconnectObserver: NSObjectProtocol?
  private var pollTimer: Timer?
  private var watching: Bool = false

  public func definition() -> ModuleDefinition {
    Name("ExpoGameController")

    Events("onControllers", "onInput")

    Function("listControllers") { () -> [[String: Any]] in
      return GCController.controllers().map { describeController($0) }
    }

    AsyncFunction("startWatching") { (pollHz: Int) in
      DispatchQueue.main.async {
        if self.watching { return }
        self.watching = true

        self.connectObserver = NotificationCenter.default.addObserver(
          forName: .GCControllerDidConnect, object: nil, queue: .main
        ) { [weak self] _ in
          self?.emitControllers()
        }
        self.disconnectObserver = NotificationCenter.default.addObserver(
          forName: .GCControllerDidDisconnect, object: nil, queue: .main
        ) { [weak self] _ in
          self?.emitControllers()
        }

        // Tell iOS we want input from any connected controller, including
        // DualShock / DualSense / Xbox paired over Bluetooth.
        GCController.startWirelessControllerDiscovery(completionHandler: nil)

        self.emitControllers()

        let interval = 1.0 / Double(max(1, min(120, pollHz)))
        self.pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
          self?.emitInput()
        }
        if let t = self.pollTimer {
          RunLoop.main.add(t, forMode: .common)
        }
      }
    }

    AsyncFunction("stopWatching") {
      DispatchQueue.main.async {
        self.watching = false
        if let o = self.connectObserver { NotificationCenter.default.removeObserver(o) }
        if let o = self.disconnectObserver { NotificationCenter.default.removeObserver(o) }
        self.connectObserver = nil
        self.disconnectObserver = nil
        self.pollTimer?.invalidate()
        self.pollTimer = nil
        GCController.stopWirelessControllerDiscovery()
      }
    }
  }

  private func emitControllers() {
    let list = GCController.controllers().map { describeController($0) }
    sendEvent("onControllers", ["controllers": list])
  }

  private func emitInput() {
    var frames: [[String: Any]] = []
    for c in GCController.controllers() {
      if let pad = c.extendedGamepad {
        frames.append([
          "id": controllerId(c),
          "buttonA": pad.buttonA.value,
          "buttonB": pad.buttonB.value,
          "buttonX": pad.buttonX.value,
          "buttonY": pad.buttonY.value,
          "dpadX": pad.dpad.xAxis.value,
          "dpadY": pad.dpad.yAxis.value,
          "leftX": pad.leftThumbstick.xAxis.value,
          "leftY": pad.leftThumbstick.yAxis.value,
          "rightX": pad.rightThumbstick.xAxis.value,
          "rightY": pad.rightThumbstick.yAxis.value,
          "leftTrigger": pad.leftTrigger.value,
          "rightTrigger": pad.rightTrigger.value,
          "leftShoulder": pad.leftShoulder.value,
          "rightShoulder": pad.rightShoulder.value,
          "leftThumbstickButton": pad.leftThumbstickButton?.value ?? 0,
          "rightThumbstickButton": pad.rightThumbstickButton?.value ?? 0,
          "buttonMenu": pad.buttonMenu.value,
          "buttonOptions": pad.buttonOptions?.value ?? 0,
          "buttonHome": pad.buttonHome?.value ?? 0,
        ])
      }
    }
    if !frames.isEmpty {
      sendEvent("onInput", ["frames": frames])
    }
  }
}

private func controllerId(_ c: GCController) -> String {
  // GCController doesn't expose a stable id; use ObjectIdentifier as a string.
  return "\(ObjectIdentifier(c).hashValue)"
}

private func describeController(_ c: GCController) -> [String: Any] {
  return [
    "id": controllerId(c),
    "vendorName": c.vendorName ?? "",
    "productCategory": c.productCategory,
    "hasExtendedGamepad": c.extendedGamepad != nil,
    "isAttachedToDevice": c.isAttachedToDevice,
    "playerIndex": c.playerIndex.rawValue,
  ]
}
