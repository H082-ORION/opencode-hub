import { describe, expect, test } from "bun:test"
import { featuredGroups, groupKey, groupProviders } from "./provider-groups"

// A slice of the models.dev catalog, in the order the hub serves it (by name).
const catalog = [
  { id: "alibaba", name: "Alibaba" },
  { id: "alibaba-cn", name: "Alibaba (China)" },
  { id: "alibaba-coding-plan", name: "Alibaba Coding Plan" },
  { id: "alibaba-coding-plan-cn", name: "Alibaba Coding Plan (China)" },
  { id: "alibaba-token-plan", name: "Alibaba Token Plan" },
  { id: "alibaba-token-plan-cn", name: "Alibaba Token Plan (China)" },
  { id: "anthropic", name: "Anthropic" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "google", name: "Google" },
  { id: "kimi-code-plan-global", name: "Kimi For Coding (kimi.ai)" },
  { id: "kimi-code-plan-cn", name: "Kimi For Coding (kimi.com)" },
  { id: "minimax-cn", name: "MiniMax (minimax.cn)" },
  { id: "minimax", name: "MiniMax (minimax.io)" },
  { id: "minimax-cn-coding-plan", name: "MiniMax Token Plan (minimax.cn)" },
  { id: "minimax-coding-plan", name: "MiniMax Token Plan (minimax.io)" },
  { id: "mistral", name: "Mistral" },
  { id: "moonshotai", name: "Moonshot AI" },
  { id: "moonshotai-cn", name: "Moonshot AI (China)" },
  { id: "openai", name: "OpenAI" },
  { id: "stepfun-plan", name: "StepFun Plan (Global)" },
  { id: "stepfun-cn", name: "StepFun (China)" },
  { id: "zai", name: "Z.AI" },
  { id: "zai-coding-plan", name: "Z.AI Coding Plan" },
  { id: "zhipuai", name: "Zhipu AI" },
  { id: "zhipuai-coding-plan", name: "Zhipu AI Coding Plan" },
]

const groups = groupProviders(catalog)

const group = (key: string) => groups.find((item) => item.key === key)

const ids = (key: string) => group(key)?.entries.map((entry) => entry.id)

describe("provider groups", () => {
  test("keys an id by its first segment, through the alias map", () => {
    expect(groupKey("alibaba-coding-plan-cn")).toBe("alibaba")
    expect(groupKey("zai")).toBe("zai")
    expect(groupKey("kimi-code-plan-global")).toBe("moonshotai")
  })

  test("groups a company's regions and plans", () => {
    expect(ids("alibaba")).toEqual([
      "alibaba",
      "alibaba-cn",
      "alibaba-coding-plan",
      "alibaba-coding-plan-cn",
      "alibaba-token-plan",
      "alibaba-token-plan-cn",
    ])
    expect(ids("zai")).toEqual(["zai", "zai-coding-plan"])
    expect(ids("zhipuai")).toEqual(["zhipuai", "zhipuai-coding-plan"])
  })

  test("lists the entry named by the key first and names the group without its parenthetical", () => {
    expect(group("minimax")?.name).toBe("MiniMax")
    expect(ids("minimax")).toEqual(["minimax", "minimax-cn", "minimax-cn-coding-plan", "minimax-coding-plan"])
  })

  test("puts Kimi under Moonshot AI", () => {
    expect(group("moonshotai")?.name).toBe("Moonshot AI")
    expect(ids("moonshotai")).toEqual(["moonshotai", "moonshotai-cn", "kimi-code-plan-global", "kimi-code-plan-cn"])
    expect(group("kimi")).toBeUndefined()
  })

  test("names a group without a lead entry after its first entry", () => {
    expect(group("stepfun")?.name).toBe("StepFun Plan")
    expect(ids("stepfun")).toEqual(["stepfun-plan", "stepfun-cn"])
  })

  test("keeps a single-entry company as its own group, and sorts groups by name", () => {
    expect(group("deepseek")).toEqual({
      key: "deepseek",
      name: "DeepSeek",
      entries: [{ id: "deepseek", name: "DeepSeek" }],
    })
    expect(groups.map((item) => item.name)).toEqual([
      "Alibaba",
      "Anthropic",
      "DeepSeek",
      "Google",
      "MiniMax",
      "Mistral",
      "Moonshot AI",
      "OpenAI",
      "StepFun Plan",
      "Z.AI",
      "Zhipu AI",
    ])
  })

  test("features the main companies in order and skips the missing ones", () => {
    expect(featuredGroups(groups).map((item) => item.key)).toEqual([
      "anthropic",
      "openai",
      "mistral",
      "moonshotai",
      "minimax",
    ])
    expect(featuredGroups([])).toEqual([])
  })
})
