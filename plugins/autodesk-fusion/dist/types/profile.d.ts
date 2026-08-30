import { z } from 'zod/v4';
declare const profileSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    id: z.ZodString;
    mode: z.ZodEnum<{
        assisted: "assisted";
        fixture: "fixture";
        managed: "managed";
    }>;
    stateRoot: z.ZodString;
    desktop: z.ZodOptional<z.ZodObject<{
        provider: z.ZodDefault<z.ZodEnum<{
            addin: "addin";
            native: "native";
        }>>;
        url: z.ZodString;
        tokenFile: z.ZodOptional<z.ZodString>;
        mapping: z.ZodOptional<z.ZodObject<{
            tool: z.ZodString;
            argument: z.ZodString;
            schemaHash: z.ZodString;
            fixedArguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    policy: z.ZodObject<{
        mutationsEnabled: z.ZodDefault<z.ZodBoolean>;
        effects: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            administration: "administration";
            cloud_compute: "cloud_compute";
            cloud_write: "cloud_write";
            local_artifact: "local_artifact";
            local_edit: "local_edit";
        }>>>;
        operations: z.ZodDefault<z.ZodArray<z.ZodString>>;
        documents: z.ZodDefault<z.ZodArray<z.ZodString>>;
        readDocuments: z.ZodOptional<z.ZodArray<z.ZodString>>;
        planMaxAgeMs: z.ZodDefault<z.ZodNumber>;
        grantExpiresAt: z.ZodOptional<z.ZodString>;
        allowUnsavedCreation: z.ZodDefault<z.ZodBoolean>;
        allowCreatedDocuments: z.ZodDefault<z.ZodBoolean>;
        qualificationDocuments: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowNonAtomicCloudWrites: z.ZodDefault<z.ZodBoolean>;
        allowedDataFiles: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            versionId: z.ZodString;
        }, z.core.$strict>>>;
        saveFolders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        qualifiedOperations: z.ZodDefault<z.ZodArray<z.ZodString>>;
        qualificationEvidence: z.ZodOptional<z.ZodString>;
        desktopQualification: z.ZodOptional<z.ZodObject<{
            version: z.ZodLiteral<1>;
            provider: z.ZodEnum<{
                addin: "addin";
                native: "native";
            }>;
            fusionVersion: z.ZodString;
            platform: z.ZodString;
            arch: z.ZodString;
            osRelease: z.ZodString;
            handlerSha256: z.ZodString;
            executionContractSha256: z.ZodString;
            expiresAt: z.ZodString;
            evidence: z.ZodString;
            reviewer: z.ZodString;
        }, z.core.$strict>>;
        maxPlansPerMinute: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>;
    outputs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodString;
    }, z.core.$strict>>>;
    assets: z.ZodDefault<z.ZodObject<{
        templates: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$strict>>>;
        posts: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$strict>>>;
        machines: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$strict>>>;
        toolLibraries: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$strict>>>;
        imports: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path: z.ZodString;
            sha256: z.ZodString;
            trusted: z.ZodLiteral<true>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    manufacturing: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        postId: z.ZodString;
        machineId: z.ZodString;
        toolLibrarySha256: z.ZodString;
        strategyIds: z.ZodArray<z.ZodString>;
        units: z.ZodEnum<{
            in: "in";
            mm: "mm";
        }>;
        qualificationEvidence: z.ZodString;
        reviewRecords: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            sourceState: z.ZodString;
            method: z.ZodString;
            reviewedBy: z.ZodString;
            expiresAt: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>>;
    cloud: z.ZodOptional<z.ZodObject<{
        clientId: z.ZodOptional<z.ZodString>;
        tenantId: z.ZodString;
        scopes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        redirectUri: z.ZodOptional<z.ZodString>;
        hubIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        projects: z.ZodDefault<z.ZodArray<z.ZodObject<{
            hubId: z.ZodString;
            projectId: z.ZodString;
        }, z.core.$strict>>>;
        mfgModels: z.ZodDefault<z.ZodArray<z.ZodObject<{
            modelId: z.ZodString;
            hubId: z.ZodString;
            projectId: z.ZodString;
            configurationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$strict>>>;
        manage: z.ZodOptional<z.ZodObject<{
            tenant: z.ZodString;
            workspaceIds: z.ZodArray<z.ZodNumber>;
        }, z.core.$strict>>;
        recipesFile: z.ZodOptional<z.ZodString>;
        enterpriseAdapter: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            sha256: z.ZodString;
        }, z.core.$strict>>;
        propertyRules: z.ZodDefault<z.ZodArray<z.ZodObject<{
            propertyDefinitionId: z.ZodString;
            type: z.ZodEnum<{
                boolean: "boolean";
                number: "number";
                string: "string";
            }>;
            allowNull: z.ZodBoolean;
            maxLength: z.ZodOptional<z.ZodNumber>;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodOptional<z.ZodString>;
            owner: z.ZodLiteral<"product">;
        }, z.core.$strict>>>;
        budget: z.ZodOptional<z.ZodObject<{
            maxConcurrentJobs: z.ZodNumber;
            maxSubmissions: z.ZodNumber;
            maxReservedUnits: z.ZodNumber;
            currency: z.ZodString;
            period: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type FusionProfile = z.infer<typeof profileSchema>;
export declare const defaultStateRoot: () => string;
export declare function fixtureProfile(stateRoot?: string): FusionProfile;
export declare function parseProfile(value: unknown): FusionProfile;
export declare function loadProfile(filename?: string): Promise<FusionProfile>;
export declare const profileHash: (profile: FusionProfile) => string;
/** Read a bounded, unchanged, administrator/current-user-owned local file. */
export declare function readTrustedFile(filename: string, maxBytes?: number): Promise<{
    bytes: Buffer;
    canonicalPath: string;
}>;
/** Privileged deployment extension, never a model-provided code path. */
export declare function verifyTrustedExecutableAsset(asset: {
    path: string;
    sha256: string;
}): Promise<string>;
export declare function authorize(profile: FusionProfile, operation: string, effect: string, documentId?: string): void;
export {};
