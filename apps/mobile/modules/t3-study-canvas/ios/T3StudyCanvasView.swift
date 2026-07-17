import ExpoModulesCore
import PencilKit
import UIKit

public final class T3StudyCanvasView: ExpoView, PKCanvasViewDelegate {
  private static let worldSize = CGSize(width: 16_384, height: 16_384)
  private static let minimumSelectionSize: CGFloat = 12
  private static let maximumExportDimension: CGFloat = 2_048

  private let canvasView = PKCanvasView(frame: .zero)
  private let selectionOverlay = UIView(frame: .zero)
  private let selectionLayer = CAShapeLayer()
  private let toolPicker = PKToolPicker()
  private let onDrawingChange = EventDispatcher()
  private let onSelectionChange = EventDispatcher()

  private var revision = 0
  private var selectionMode = false
  private var selectionStart: CGPoint?
  private var selectionRectInOverlay: CGRect?
  private var selectionRectInCanvas: CGRect?
  private var centeredInitialViewport = false
  private var observingToolPicker = false
  private var isRestoringDrawing = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = true
    canvasView.translatesAutoresizingMaskIntoConstraints = false
    canvasView.backgroundColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.075, green: 0.075, blue: 0.082, alpha: 1)
        : UIColor(red: 0.985, green: 0.98, blue: 0.965, alpha: 1)
    }
    canvasView.contentSize = Self.worldSize
    canvasView.minimumZoomScale = 0.2
    canvasView.maximumZoomScale = 4
    canvasView.bouncesZoom = true
    canvasView.alwaysBounceHorizontal = true
    canvasView.alwaysBounceVertical = true
    canvasView.drawingPolicy = .anyInput
    canvasView.delegate = self
    canvasView.tool = PKInkingTool(.pen, color: .label, width: 4)
    addSubview(canvasView)

    selectionOverlay.translatesAutoresizingMaskIntoConstraints = false
    selectionOverlay.backgroundColor = .clear
    selectionOverlay.isUserInteractionEnabled = false
    addSubview(selectionOverlay)

    selectionLayer.fillColor = UIColor.systemBlue.withAlphaComponent(0.12).cgColor
    selectionLayer.strokeColor = UIColor.systemBlue.cgColor
    selectionLayer.lineWidth = 2
    selectionLayer.lineDashPattern = [8, 5]
    selectionOverlay.layer.addSublayer(selectionLayer)

    let selectionPan = UIPanGestureRecognizer(target: self, action: #selector(handleSelectionPan(_:)))
    selectionPan.maximumNumberOfTouches = 1
    selectionOverlay.addGestureRecognizer(selectionPan)

    NSLayoutConstraint.activate([
      canvasView.leadingAnchor.constraint(equalTo: leadingAnchor),
      canvasView.trailingAnchor.constraint(equalTo: trailingAnchor),
      canvasView.topAnchor.constraint(equalTo: topAnchor),
      canvasView.bottomAnchor.constraint(equalTo: bottomAnchor),
      selectionOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
      selectionOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
      selectionOverlay.topAnchor.constraint(equalTo: topAnchor),
      selectionOverlay.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if canvasView.contentSize.width < Self.worldSize.width ||
      canvasView.contentSize.height < Self.worldSize.height {
      canvasView.contentSize = Self.worldSize
    }
    selectionLayer.frame = selectionOverlay.bounds
    updateSelectionPath()

    guard !centeredInitialViewport, bounds.width > 0, bounds.height > 0 else {
      return
    }
    centeredInitialViewport = true
    canvasView.contentOffset = CGPoint(
      x: max(0, (Self.worldSize.width - bounds.width) / 2),
      y: max(0, (Self.worldSize.height - bounds.height) / 2)
    )
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      if observingToolPicker {
        toolPicker.removeObserver(canvasView)
        observingToolPicker = false
      }
      return
    }
    if !observingToolPicker {
      toolPicker.addObserver(canvasView)
      observingToolPicker = true
    }
    updateToolPickerVisibility()
  }

  public func setSelectionMode(_ enabled: Bool) {
    if selectionMode, !enabled {
      clearSelection()
    }
    selectionMode = enabled
    selectionOverlay.isUserInteractionEnabled = enabled
    canvasView.isUserInteractionEnabled = !enabled
    updateToolPickerVisibility()
  }

  public func loadDrawing(dataBase64: String, revision: Int) throws {
    guard let data = Data(base64Encoded: dataBase64) else {
      throw NSError(
        domain: "T3StudyCanvas",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Drawing data is not valid base64."]
      )
    }
    let drawing = try PKDrawing(data: data)
    isRestoringDrawing = true
    defer { isRestoringDrawing = false }
    self.revision = max(0, revision)
    canvasView.drawing = drawing
  }

  public func exportDrawing() -> String {
    canvasView.drawing.dataRepresentation().base64EncodedString()
  }

  public func exportRegion() -> [String: Any] {
    guard let rect = selectionRectInCanvas, rect.width > 0, rect.height > 0 else {
      return ["pngBase64": ""]
    }

    let largestDimension = max(rect.width, rect.height)
    let screenScale = window?.screen.scale ?? UIScreen.main.scale
    let scale = min(screenScale, Self.maximumExportDimension / max(1, largestDimension))
    let image = canvasView.drawing.image(from: rect, scale: scale)
    guard let pngData = image.pngData() else {
      return ["pngBase64": ""]
    }

    return [
      "pngBase64": pngData.base64EncodedString(),
      "rect": rectPayload(rect),
      "revision": revision,
    ]
  }

  public func undo() {
    canvasView.undoManager?.undo()
  }

  public func redo() {
    canvasView.undoManager?.redo()
  }

  public func clear() {
    guard !canvasView.drawing.strokes.isEmpty else {
      return
    }
    canvasView.drawing = PKDrawing()
    drawingDidChange()
  }

  public func clearSelection() {
    selectionStart = nil
    selectionRectInOverlay = nil
    selectionRectInCanvas = nil
    updateSelectionPath()
    onSelectionChange(["selected": false])
  }

  public func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    guard !isRestoringDrawing else {
      return
    }
    drawingDidChange()
  }

  private func drawingDidChange() {
    revision += 1
    var payload: [String: Any] = ["revision": revision]
    let bounds = canvasView.drawing.bounds
    if !bounds.isNull, !bounds.isEmpty {
      payload["contentBounds"] = rectPayload(bounds)
    }
    onDrawingChange(payload)
  }

  private func updateToolPickerVisibility() {
    guard window != nil else {
      return
    }
    toolPicker.setVisible(!selectionMode, forFirstResponder: canvasView)
    if !selectionMode {
      canvasView.becomeFirstResponder()
    }
  }

  @objc private func handleSelectionPan(_ gesture: UIPanGestureRecognizer) {
    let point = gesture.location(in: selectionOverlay)
    switch gesture.state {
    case .began:
      selectionStart = point
      selectionRectInOverlay = CGRect(origin: point, size: .zero)
      updateSelectionPath()
    case .changed:
      guard let start = selectionStart else {
        return
      }
      selectionRectInOverlay = CGRect(
        x: min(start.x, point.x),
        y: min(start.y, point.y),
        width: abs(point.x - start.x),
        height: abs(point.y - start.y)
      )
      updateSelectionPath()
    case .ended:
      finishSelection()
    case .cancelled, .failed:
      clearSelection()
    default:
      break
    }
  }

  private func finishSelection() {
    selectionStart = nil
    guard let overlayRect = selectionRectInOverlay,
          overlayRect.width >= Self.minimumSelectionSize,
          overlayRect.height >= Self.minimumSelectionSize else {
      clearSelection()
      return
    }

    let converted = selectionOverlay.convert(overlayRect, to: canvasView).standardized
    let worldBounds = CGRect(origin: .zero, size: canvasView.contentSize)
    let canvasRect = converted.intersection(worldBounds)
    guard !canvasRect.isNull, !canvasRect.isEmpty else {
      clearSelection()
      return
    }
    selectionRectInCanvas = canvasRect
    updateSelectionPath()
    onSelectionChange([
      "selected": true,
      "rect": rectPayload(canvasRect),
      "revision": revision,
    ])
  }

  private func updateSelectionPath() {
    guard let rect = selectionRectInOverlay else {
      selectionLayer.path = nil
      return
    }
    selectionLayer.path = UIBezierPath(roundedRect: rect, cornerRadius: 8).cgPath
  }

  private func rectPayload(_ rect: CGRect) -> [String: Double] {
    [
      "x": Double(rect.origin.x),
      "y": Double(rect.origin.y),
      "width": Double(rect.size.width),
      "height": Double(rect.size.height),
    ]
  }
}
