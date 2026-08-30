import { McpServer } from '@modelcontextprotocol/server';
import { type Runtime } from './runtime.js';
export declare function createFusionServer(runtime: Runtime): McpServer;
export declare function startServer(): Promise<void>;
