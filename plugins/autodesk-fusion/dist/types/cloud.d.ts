import { type CloudTransportOptions } from "./cloud-http.js";
export { APS_ORIGIN, CloudError, CloudRateLimiter, cloudHash, cloudSourceHash, parseRetryAfter, redactCloudData, validateAutodeskOrigin } from "./cloud-http.js";
export interface CloudScope {
    tenantId: string;
    hubIds: string[];
    projects: {
        hubId: string;
        projectId: string;
    }[];
    mfgModels?: {
        modelId: string;
        hubId: string;
        projectId: string;
        configurationId?: string | null;
    }[];
    manage?: {
        tenant: string;
        workspaceIds: number[];
    };
}
export interface CloudPageOptions {
    pageNumber?: number;
    pageSize?: number;
}
export interface CloudPage {
    data: unknown[];
    scope: {
        tenantId: string;
        hubId?: string;
        projectId?: string;
    };
    pagination: {
        pageNumber: number;
        pageSize: number;
        nextPageNumber: number | null;
        complete: boolean;
    };
}
export interface MfgContext {
    modelId: string;
    timestamp: string;
    composition: "AS_SAVED";
    configurationId?: string | null;
}
export interface MfgQueryResult {
    scope: CloudScope["mfgModels"] extends (infer T)[] | undefined ? T & {
        tenantId: string;
    } : never;
    context: MfgContext;
    documentId: string;
    documentHash: string;
    data: unknown;
    errors: {
        code: string;
        path: (string | number)[];
    }[];
    partial: boolean;
    complete: boolean;
    cursor: string | null;
    snapshotHash: string;
}
export interface MfgPropertyRule {
    propertyDefinitionId: string;
    type: "string" | "number" | "boolean";
    allowNull: boolean;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    unit?: string;
    owner: "product";
}
export interface MfgPropertyObservation {
    tenantId: string;
    modelId: string;
    componentId: string;
    propertyDefinitionId: string;
    timestamp: string;
    value: string | number | boolean | null;
    snapshotHash: string;
    definitionHash?: string;
}
export interface MfgPropertyDraft {
    status: "draft";
    context: MfgContext;
    componentId: string;
    propertyDefinitionId: string;
    before: string | number | boolean | null;
    after: string | number | boolean | null;
    observationHash: string;
    ruleHash: string;
    documentHash: string;
    draftHash: string;
    requiresApproval: true;
    atomicConcurrency: false;
}
export interface ApsClientOptions extends Omit<CloudTransportOptions, "tenantId" | "manageTenant"> {
    scope: CloudScope;
    propertyRules?: MfgPropertyRule[];
    /** Enterprise adapter must supply a qualified, reviewed read projection for its custom property schema. */
    observeProperty?: (context: MfgContext, propertyDefinitionId: string) => Promise<MfgPropertyObservation>;
}
export declare const MFG_QUERY_DOCUMENTS: Readonly<{
    [k: string]: Readonly<{
        id: string;
        document: "mutation CodexClearProperty($propertyId: ID!, $componentId: ID!) {\n    setProperties(input: { targetId: $componentId, propertyInputs: [{ propertyDefinitionId: $propertyId, shouldClear: true }] }) {\n      properties { value }\n    }\n  }" | "mutation CodexSetProperty($propertyId: ID!, $componentId: ID!, $propertyValue: PropertyValue!) {\n    setProperties(input: { targetId: $componentId, propertyInputs: [{ propertyDefinitionId: $propertyId, value: $propertyValue }] }) {\n      properties { value }\n    }\n  }" | "query CodexCurrentProperty($modelId: ID!, $cursor: String) {\n    model(modelId: $modelId, composition: AS_SAVED) {\n      id timestamp component {\n        id customProperties(pagination: {cursor: $cursor}) {\n          results { value definition { id isReadOnly isArchived specification propertyBehavior units { name } } }\n          pagination { cursor }\n        }\n      }\n    }\n  }" | "query CodexInspectHistory($modelId: ID!, $time: DateTime!) {\n    model(modelId: $modelId, time: $time, composition: AS_SAVED) {\n      id timestamp history { results { timeStamp description } }\n    }\n  }" | "query CodexInspectModel($modelId: ID!, $time: DateTime!, $cursor: String) {\n    model(modelId: $modelId, time: $time, composition: AS_SAVED) {\n      id timestamp name { value displayValue }\n      component { id partNumber { value displayValue } description { value displayValue } }\n      assemblyRelations(pagination: {cursor: $cursor}) {\n        results { fromModel { id } toModel { id timestamp name { value displayValue } version { timestamp } } }\n        pagination { cursor }\n      }\n    }\n  }" | "query CodexInspectPhysicalProperties($modelId: ID!, $time: DateTime!) {\n    model(modelId: $modelId, time: $time, composition: AS_SAVED) {\n      id timestamp physicalProperties {\n        status\n        area { value displayValue definition { units { name } } }\n        volume { value displayValue definition { units { name } } }\n        mass { value displayValue definition { units { name } } }\n        density { value displayValue definition { units { name } } }\n      }\n    }\n  }" | "query CodexPropertyInputSchema($typeName: String!) {\n    __type(name: $typeName) { inputFields { name } }\n  }" | "query CodexPropertySchema {\n    componentType: __type(name: \"Component\") { fields { name args { name } } }\n    setInput: __type(name: \"SetPropertiesInput\") { inputFields { name type { name ofType { name ofType { name ofType { name } } } } } }\n  }";
        hash: string;
        kind: "mutation" | "query";
        endpoint: "https://developer.api.autodesk.com/mfg/v3/graphql/public";
    }>;
}>;
export declare function validateCloudScope(scope: CloudScope): CloudScope;
export declare class ApsClient {
    #private;
    constructor(options: ApsClientOptions);
    get scope(): CloudScope;
    toJSON(): {
        type: string;
        scope: CloudScope;
        nativeMcpCredentialsInherited: boolean;
    };
    listHubs(): Promise<CloudPage>;
    listProjects(hubId: string, options?: CloudPageOptions): Promise<CloudPage>;
    listTopFolders(hubId: string, projectId: string): Promise<CloudPage>;
    listFolderContents(projectId: string, folderId: string, options?: CloudPageOptions): Promise<CloudPage>;
    getFolder(projectId: string, folderId: string): Promise<{
        data: unknown;
        scope: {
            hubId: string;
            projectId: string;
            tenantId: string;
        };
        etag: string | null;
        fingerprint: string;
    }>;
    getItem(projectId: string, itemId: string): Promise<{
        data: unknown;
        scope: {
            hubId: string;
            projectId: string;
            tenantId: string;
        };
        etag: string | null;
        fingerprint: string;
    }>;
    getVersion(projectId: string, versionId: string): Promise<{
        data: unknown;
        scope: {
            hubId: string;
            projectId: string;
            tenantId: string;
        };
        etag: string | null;
        fingerprint: string;
    }>;
    listItemVersions(projectId: string, itemId: string, options?: CloudPageOptions): Promise<CloudPage>;
    inspectMfgModel(context: MfgContext & {
        cursor?: string | null;
    }): Promise<MfgQueryResult>;
    inspectMfgHistory(context: MfgContext): Promise<MfgQueryResult>;
    inspectMfgPhysicalProperties(context: MfgContext): Promise<MfgQueryResult>;
    prepareMfgPropertyChange(context: MfgContext, propertyDefinitionId: string, after: string | number | boolean | null): Promise<MfgPropertyDraft>;
    observeMfgProperty(context: MfgContext, propertyDefinitionId: string): Promise<MfgPropertyObservation>;
    executeMfgPropertyChange(draft: MfgPropertyDraft, authority: {
        /** This is a trusted host-policy callback, not a model-provided approval boolean. */
        authorize: (draftHash: string, effect: "shared_business_change") => Promise<void>;
        requireAtomicConcurrency: boolean;
    }): Promise<{
        status: string;
        data: unknown;
        errors: {
            code: string;
            path: (string | number)[];
        }[];
        outcome: string;
        warnings: string[];
        draftHash: string;
    }>;
    getManageWorkspace(workspaceId: number): Promise<{
        data: unknown;
        fingerprint: string;
        etag: string | null;
        scope: {
            tenantId: string;
            manageTenant: string;
            workspaceId: number | null;
        };
    }>;
    getManageFields(workspaceId: number): Promise<{
        data: unknown;
        fingerprint: string;
        etag: string | null;
        scope: {
            tenantId: string;
            manageTenant: string;
            workspaceId: number | null;
        };
    }>;
    getManageItem(workspaceId: number, itemId: number): Promise<{
        data: unknown;
        fingerprint: string;
        etag: string | null;
        scope: {
            tenantId: string;
            manageTenant: string;
            workspaceId: number | null;
        };
    }>;
    prepareManageItemDraft(workspaceId: number, itemId: number, schema: ManageDraftSchema, changes: ManageDraftField[]): Promise<{
        status: string;
        tenantId: string;
        manageTenant: string;
        workspaceId: number;
        itemId: number;
        schemaFingerprint: string;
        expectedItemFingerprint: string;
        expectedEtag: string | null;
        changes: ManageDraftField[];
        sourceItem: unknown;
        requiresApproval: boolean;
        releaseApproved: boolean;
        publicationSupported: boolean;
        blocker: string;
        draftHash: string;
    }>;
}
export interface ManageDraftSchema {
    tenant: string;
    workspaceId: number;
    schemaFingerprint: string;
    fields: {
        fieldId: string;
        type: "string" | "number" | "boolean";
        allowNull: boolean;
        allowDraftUpdate: boolean;
        lifecycle: boolean;
        minimum?: number;
        maximum?: number;
        maxLength?: number;
    }[];
}
export interface ManageDraftField {
    fieldId: string;
    after: string | number | boolean | null;
    sourceRef: string;
}
