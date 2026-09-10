import { createShiftContinuityAgentCoreApp } from "./app.ts";

// AgentCore CodeZip entrypoint (agentcore/agentcore.json → entrypoint main.js).
// The runtime provides PORT; 8080 is the AgentCore default.
const port = parseInt(process.env.PORT ?? "8080", 10);

createShiftContinuityAgentCoreApp().run({ port });
