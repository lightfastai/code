import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { ArtifactRenderer, hasArtifactRenderer } from "./ArtifactRenderer.tsx";

describe("artifact renderer registry", () => {
  it("registers the versioned 3D scene renderer", () => {
    expect(hasArtifactRenderer("3d-scene")).toBe(true);
  });

  it("does not claim unknown artifact kinds", () => {
    expect(hasArtifactRenderer("javascript-widget")).toBe(false);
  });

  it("renders an explicit fallback for unknown artifacts", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactRenderer, {
        artifact: {
          type: "artifact",
          id: "artifact-future",
          kind: "vendor.future",
          schemaVersion: 7,
          title: "Future artifact",
          payload: { opaque: true },
        },
      }),
    );

    expect(html).toContain("Unsupported artifact");
    expect(html).toContain("vendor.future v7");
  });
});
