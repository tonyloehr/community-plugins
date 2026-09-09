import { z } from 'zod/v4';
import type { OperationDefinition, OperationInput } from './types.js';
type Entry = OperationDefinition & {
    schema: z.ZodType;
    document: boolean;
};
export declare const operationCatalog: ReadonlyMap<string, Entry>;
export declare function describeOperations(family?: string, includeSchema?: boolean): unknown[];
export declare function getOperation(id: string): Entry;
export declare function parseOperation(value: unknown): OperationInput;
export declare const capabilityBoundaries: readonly [{
    readonly family: 'drawings.author';
    readonly maturity: 'preview';
    readonly status: 'research_only';
    readonly reason: 'Automatic drawing creation is preview; existing drawing PDF export has its own released path.';
}, {
    readonly family: 'electronics';
    readonly maturity: 'preview';
    readonly status: 'research_only';
    readonly reason: 'Preview inspection is not unrestricted schematic/PCB authoring or fresh ERC/DRC execution.';
}, {
    readonly family: 'simulation';
    readonly maturity: 'preview';
    readonly status: 'human_handoff';
    readonly reason: 'Insider simulation APIs are not a released supported solver interface.';
}, {
    readonly family: 'generative_design';
    readonly maturity: 'unverified';
    readonly status: 'human_handoff';
    readonly reason: 'No qualified public generation/solve API is advertised.';
}, {
    readonly family: 'manufacturing.release';
    readonly maturity: 'unverified';
    readonly status: 'human_handoff';
    readonly reason: 'No structured machine collision proof or physical machine control is implemented.';
}, {
    readonly family: 'sheet_metal.advanced';
    readonly maturity: 'preview';
    readonly status: 'research_only';
    readonly reason: 'Released collection access is not authoring; fold/convert/join variants require separate API qualification.';
}, {
    readonly family: 'ui.arbitrary';
    readonly maturity: 'unverified';
    readonly status: 'assisted_only';
    readonly reason: 'Native raw tools are outside the typed managed facade. They cannot provide managed-policy guarantees.';
}];
export {};
