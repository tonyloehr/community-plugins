import { z } from 'zod/v4';
import { type ManageDraftField, type ManageDraftSchema } from './cloud.js';
/** Local owner policy, not a provider response schema and never a tool input. */
export declare const manageDraftTrustedSchema: z.ZodObject<{
    tenant: z.ZodString;
    workspaceId: z.ZodNumber;
    schemaFingerprint: z.ZodString;
    fields: z.ZodArray<z.ZodObject<{
        fieldId: z.ZodString;
        type: z.ZodEnum<{
            boolean: "boolean";
            number: "number";
            string: "string";
        }>;
        allowNull: z.ZodBoolean;
        allowDraftUpdate: z.ZodBoolean;
        lifecycle: z.ZodBoolean;
        maxLength: z.ZodOptional<z.ZodNumber>;
        minimum: z.ZodOptional<z.ZodNumber>;
        maximum: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const manageDraftRegistrySchema: z.ZodArray<z.ZodObject<{
    tenant: z.ZodString;
    workspaceId: z.ZodNumber;
    schemaFingerprint: z.ZodString;
    fields: z.ZodArray<z.ZodObject<{
        fieldId: z.ZodString;
        type: z.ZodEnum<{
            boolean: "boolean";
            number: "number";
            string: "string";
        }>;
        allowNull: z.ZodBoolean;
        allowDraftUpdate: z.ZodBoolean;
        lifecycle: z.ZodBoolean;
        maxLength: z.ZodOptional<z.ZodNumber>;
        minimum: z.ZodOptional<z.ZodNumber>;
        maximum: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>>;
export declare const manageDraftPrepareSchema: z.ZodObject<{
    workspace_id: z.ZodNumber;
    item_id: z.ZodNumber;
    changes: z.ZodArray<z.ZodObject<{
        field_id: z.ZodString;
        after: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>;
        source_ref: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const manageDraftInspectSchema: z.ZodObject<{
    draft_id: z.ZodString;
}, z.core.$strict>;
export type ManageDraftInput = z.infer<typeof manageDraftPrepareSchema>;
export declare function parseManageDraftInput(value: unknown): ManageDraftInput;
/** Validate locally before any token request or provider read. */
export declare function manageDraftChanges(schema: ManageDraftSchema, request: ManageDraftInput): ManageDraftField[];
declare const recordSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    id: z.ZodString;
    operation: z.ZodLiteral<"manage.item_draft">;
    profile_id: z.ZodString;
    profile_hash: z.ZodString;
    scope_hash: z.ZodString;
    authorization_binding: z.ZodString;
    schema_hash: z.ZodString;
    request_hash: z.ZodString;
    created_at: z.ZodString;
    observed_at: z.ZodString;
    expires_at: z.ZodString;
    trusted_schema: z.ZodObject<{
        tenant: z.ZodString;
        workspaceId: z.ZodNumber;
        schemaFingerprint: z.ZodString;
        fields: z.ZodArray<z.ZodObject<{
            fieldId: z.ZodString;
            type: z.ZodEnum<{
                boolean: "boolean";
                number: "number";
                string: "string";
            }>;
            allowNull: z.ZodBoolean;
            allowDraftUpdate: z.ZodBoolean;
            lifecycle: z.ZodBoolean;
            maxLength: z.ZodOptional<z.ZodNumber>;
            minimum: z.ZodOptional<z.ZodNumber>;
            maximum: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    request: z.ZodObject<{
        workspace_id: z.ZodNumber;
        item_id: z.ZodNumber;
        changes: z.ZodArray<z.ZodObject<{
            field_id: z.ZodString;
            after: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>;
            source_ref: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    draft: z.ZodObject<{
        status: z.ZodLiteral<"draft_outbox">;
        tenantId: z.ZodString;
        manageTenant: z.ZodString;
        workspaceId: z.ZodNumber;
        itemId: z.ZodNumber;
        schemaFingerprint: z.ZodString;
        expectedItemFingerprint: z.ZodString;
        expectedEtag: z.ZodNullable<z.ZodString>;
        changes: z.ZodArray<z.ZodObject<{
            fieldId: z.ZodString;
            after: z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>;
            sourceRef: z.ZodString;
        }, z.core.$strict>>;
        sourceItem: z.ZodJSONSchema;
        requiresApproval: z.ZodLiteral<true>;
        releaseApproved: z.ZodLiteral<false>;
        publicationSupported: z.ZodLiteral<false>;
        blocker: z.ZodString;
        draftHash: z.ZodString;
    }, z.core.$strict>;
    record_hash: z.ZodString;
}, z.core.$strict>;
export type ManageDraftRecord = z.infer<typeof recordSchema>;
export type ManageSdkDraft = ManageDraftRecord['draft'];
export declare function manageDraftRecordBinding(record: ManageDraftRecord): Omit<ManageDraftRecord, 'record_hash'>;
/** Pure immutable-shape/hash check; grants no current scope, freshness or release. */
export declare function verifyManageDraftRecord(value: unknown): ManageDraftRecord;
/** Verify the actual SDK result, without interpreting or inventing field values. */
export declare function verifyManageSdkDraft(value: unknown, expected: {
    tenantId: string;
    schema: ManageDraftSchema;
    request: ManageDraftInput;
}): ManageSdkDraft;
export declare function reviewManageDraft(record: ManageDraftRecord, observedAt: string): {
    id: string;
    operation: "manage.item_draft";
    status: 'draft_outbox';
    record_hash: string;
    stored_draft_hash: string;
    review_hash: string;
    created_at: string;
    expires_at: string;
    context: {
        profile_id: string;
        profile_hash: string;
        scope_hash: string;
        account_context_hash: string;
        schema_hash: string;
        request_hash: string;
    };
    review: Omit<{
        status: "draft_outbox";
        tenantId: string;
        manageTenant: string;
        workspaceId: number;
        itemId: number;
        schemaFingerprint: string;
        expectedItemFingerprint: string;
        expectedEtag: string | null;
        changes: {
            fieldId: string;
            after: string | number | boolean | null;
            sourceRef: string;
        }[];
        sourceItem: z.JSONType;
        requiresApproval: true;
        releaseApproved: false;
        publicationSupported: false;
        blocker: string;
        draftHash: string;
    }, "draftHash">;
    review_redacted: boolean;
    freshness: {
        checked_at: string;
        schema_and_item_match: boolean;
        atomic_snapshot: boolean;
        validity: string;
    };
    source_references_verified: boolean;
    provider_write_performed: boolean;
    publication_supported: boolean;
    release_approved: boolean;
    live_qualified: boolean;
};
export type ManageDraftReview = ReturnType<typeof reviewManageDraft>;
export {};
