import { tool } from "ai"
import { RuneAiSdk } from "../src/ai-sdk.ts"
import { agentCode, rune } from "./shared.ts"

const code = tool(RuneAiSdk.make(rune))
if (!code.execute) throw new Error("Expected executable Rune AI SDK tool")

const result = await code.execute({ code: agentCode }, {
  toolCallId: "example",
  messages: [],
})

console.log(JSON.stringify(result, null, 2))
