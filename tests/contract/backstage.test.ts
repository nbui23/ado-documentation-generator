import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, parseDocument } from "yaml";

describe("Backstage integration", () => {
  it("publishes a resolvable production component and TechDocs source", async () => {
    const catalog = await readFile(resolve("catalog-info.yaml"), "utf8");
    const entities = parseAllDocuments(catalog).map((document) => document.toJS() as Entity);
    const component = entities.find(
      (entity) => entity.kind === "Component" && entity.metadata.name === "edgar",
    );

    expect(component?.metadata.annotations?.["backstage.io/techdocs-ref"]).toBe("dir:.");
    expect(component?.spec).toMatchObject({
      type: "service",
      lifecycle: "production",
      owner: "group:default/platform-engineering",
      system: "developer-experience",
    });
    expect(entities.some((entity) => entity.kind === "Group")).toBe(true);
    expect(entities.some((entity) => entity.kind === "System")).toBe(true);
    expect(entities.some((entity) => entity.kind === "Resource")).toBe(true);
  });

  it("keeps every configured TechDocs page in the repository", async () => {
    const config = parseDocument(await readFile(resolve("mkdocs.yml"), "utf8")).toJS() as {
      docs_dir: string;
      plugins: string[];
      nav: Array<Record<string, string>>;
    };

    expect(config.plugins).toContain("techdocs-core");
    await Promise.all(
      config.nav.flatMap((item) =>
        Object.values(item).map((page) =>
          expect(readFile(resolve(config.docs_dir, page), "utf8")).resolves.toBeTruthy(),
        ),
      ),
    );
  });

  it("ships a production external-builder overlay with durable Azure storage", async () => {
    const overlay = parseDocument(
      await readFile(resolve("deploy/backstage/app-config.edgar.yaml"), "utf8"),
    ).toJS() as {
      catalog: { locations: Array<{ type: string; target: string }> };
      techdocs: {
        builder: string;
        publisher: {
          type: string;
          azureBlobStorage: { containerName: string; credentials: { accountName: string } };
        };
      };
    };

    expect(overlay.catalog.locations).toEqual([{ type: "url", target: "${EDGAR_CATALOG_URL}" }]);
    expect(overlay.techdocs).toMatchObject({
      builder: "external",
      publisher: {
        type: "azureBlobStorage",
        azureBlobStorage: {
          containerName: "${TECHDOCS_AZURE_BLOB_STORAGE_CONTAINER_NAME}",
          credentials: { accountName: "${TECHDOCS_AZURE_BLOB_STORAGE_ACCOUNT_NAME}" },
        },
      },
    });
  });
});

interface Entity {
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly spec?: Readonly<Record<string, unknown>>;
}
