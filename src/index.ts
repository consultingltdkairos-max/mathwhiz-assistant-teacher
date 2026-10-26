import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

startServer(loadConfig());
