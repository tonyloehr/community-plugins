import { FusionEngine } from './engine.js';
import { CloudCoordinator, type EnterpriseCloudServices } from './cloud-coordinator.js';
import { NativeFusionClient } from './native.js';
import { type FusionProfile } from './profile.js';
export declare function pluginRoot(start?: string): Promise<string>;
export interface Runtime {
    profile: FusionProfile;
    engine: FusionEngine;
    native?: NativeFusionClient;
    cloud?: CloudCoordinator;
    root: string;
    close(): Promise<void>;
}
export declare function installedExecutionContract(root: string): Promise<{
    executionContractHash: string;
    executionContractFiles: {
        path: string;
        sha256: string;
    }[];
}>;
export declare function loadEnterpriseServices(profile: FusionProfile): Promise<{
    enterpriseServices: EnterpriseCloudServices;
    verifyEnterpriseAdapter: () => Promise<void>;
} | undefined>;
export declare function createRuntime(profileFile?: string | undefined): Promise<Runtime>;
