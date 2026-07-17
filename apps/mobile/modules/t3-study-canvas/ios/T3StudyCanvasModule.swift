import ExpoModulesCore

public final class T3StudyCanvasModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3StudyCanvas")

    View(T3StudyCanvasView.self) {
      Prop("selectionMode") { (view: T3StudyCanvasView, enabled: Bool) in
        view.setSelectionMode(enabled)
      }

      Events("onDrawingChange", "onSelectionChange")

      AsyncFunction("loadDrawing") { (view: T3StudyCanvasView, dataBase64: String, revision: Int) in
        try view.loadDrawing(dataBase64: dataBase64, revision: revision)
      }

      AsyncFunction("exportSnapshot") { (view: T3StudyCanvasView) -> [String: Any] in
        view.exportSnapshot()
      }

      AsyncFunction("freezeAndExportSnapshot") { (view: T3StudyCanvasView) -> [String: Any] in
        view.freezeAndExportSnapshot()
      }

      AsyncFunction("unfreeze") { (view: T3StudyCanvasView) in
        view.unfreeze()
      }

      AsyncFunction("exportRegion") { (view: T3StudyCanvasView) -> [String: Any] in
        view.exportRegion()
      }

      AsyncFunction("undo") { (view: T3StudyCanvasView) in
        view.undo()
      }

      AsyncFunction("redo") { (view: T3StudyCanvasView) in
        view.redo()
      }

      AsyncFunction("clear") { (view: T3StudyCanvasView) in
        view.clear()
      }

      AsyncFunction("clearSelection") { (view: T3StudyCanvasView) in
        view.clearSelection()
      }
    }
  }
}
