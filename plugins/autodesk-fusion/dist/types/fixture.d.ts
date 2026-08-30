import type { DesktopProvider, DesktopRequest, DesktopResponse } from './types.js';
import { RecordStore } from './storage.js';
export declare class FixtureDesktopProvider implements DesktopProvider {
    private store?;
    readonly kind = "synthetic_fixture";
    readonly supported: string[];
    private current;
    constructor(store?: RecordStore | undefined);
    private state;
    dispatch(request: DesktopRequest): Promise<DesktopResponse>;
}
