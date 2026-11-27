// [fork] W1: /v1/models reaches VPC providers through their binding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProviderConfigs } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { modelsV2 } from "~/src/requests/models_v2";
import type { ApiKeyAuth } from "~/src/types";

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return {};
    }
  },
}));

vi.mock("~/src/llm/credential-store", () => ({
  listProviderConfigs: vi.fn(),
}));

const mockListProviderConfigs = vi.mocked(listProviderConfigs);

const apiKeyAuth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
} as unknown as ApiKeyAuth;

function localBox(settings: Record<string, unknown>): DecryptedProviderConfig {
  return {
    id: "pcfg_local",
    provider: "local-m5",
    name: "local-m5",
    enabled: true,
    keys: [],
    settings: {
      baseUrl: "http://127.0.0.1:11435",
      modelsPath: "/v1/models",
      ...settings,
    },
    updatedAt: 1,
  };
}

async function listedIds(
  env: object,
  auth: ApiKeyAuth = apiKeyAuth,
): Promise<string[]> {
  const res = await modelsV2({ env: env as Env, apiKeyAuth: auth });
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

describe("modelsV2 with a vpc provider", () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the box's models through the allowlisted binding", async () => {
    mockListProviderConfigs.mockResolvedValue([
      localBox({ transport: "vpc", vpcBinding: "HALOGEN" }),
    ]);
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "qwen-flash" }] })),
        ),
    };

    const ids = await listedIds({
      VPC_BINDINGS: "HALOGEN:org_1",
      HALOGEN: binding,
    });

    expect(ids).toEqual(["local-m5/qwen-flash"]);
    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11435/v1/models",
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("skips a vpc provider whose binding is not allowlisted", async () => {
    mockListProviderConfigs.mockResolvedValue([
      localBox({ transport: "vpc", vpcBinding: "DB", customModels: ["x"] }),
    ]);

    const ids = await listedIds({ VPC_BINDINGS: "HALOGEN:org_1", DB: {} });

    expect(ids).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

// [fork] W16: a bound key lists its default provider plus the ones it lists.
describe("modelsV2 for a key with several providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists every provider the key may use", async () => {
    const image = { ...localBox({}), provider: "local-img", name: "local-img" };
    const other = {
      ...localBox({}),
      provider: "local-other",
      name: "local-other",
    };
    mockListProviderConfigs.mockResolvedValue([
      localBox({ customModels: ["chat-model"] }),
      {
        ...image,
        settings: { ...image.settings, customModels: ["img-model"] },
      },
      {
        ...other,
        settings: { ...other.settings, customModels: ["other-model"] },
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
    );
    const auth = {
      ...apiKeyAuth,
      scopes: {
        defaultProvider: "local-m5",
        providers: ["local-m5", "local-img"],
      },
    } as unknown as ApiKeyAuth;

    const ids = await listedIds({}, auth);

    expect(ids).toEqual(
      expect.arrayContaining(["local-m5/chat-model", "local-img/img-model"]),
    );
    expect(ids.some((id) => id.startsWith("local-other/"))).toBe(false);
  });
});

// [fork] W18: aliases replace upstream ids in the list.
describe("modelsV2 with model aliases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the alias instead of the upstream id", async () => {
    mockListProviderConfigs.mockResolvedValue([
      localBox({
        transport: "vpc",
        vpcBinding: "HALOGEN",
        modelAliases: { "z-image-turbo": "sd-cpp-local" },
      }),
    ]);
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "sd-cpp-local" }] })),
        ),
    };

    const ids = await listedIds({
      VPC_BINDINGS: "HALOGEN:org_1",
      HALOGEN: binding,
    });

    expect(ids).toEqual(["local-m5/z-image-turbo"]);
  });
});
