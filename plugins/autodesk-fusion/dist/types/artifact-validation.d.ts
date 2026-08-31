export interface PngExpectation {
    width: number;
    height: number;
}
export interface PngValidation {
    validator: 'png_container_v1';
    width: number;
    height: number;
    chunk_count: number;
    requested_dimensions: PngExpectation | null;
    dimensions_match_request: boolean | null;
    pixel_data_decoded: false;
    animation_chunks_present: boolean;
    scope: string;
}
export interface StlValidation {
    validator: 'stl_triangles_v1';
    encoding: 'binary' | 'ascii';
    triangle_count: number;
    bounds: {
        min: number[];
        max: number[];
        unit: 'file_coordinates_without_embedded_unit';
    };
    nonzero_attribute_word_count: number;
    normal_check: 'finite_components_only';
    topology_checked: false;
    scope: string;
}
export type ArtifactContentValidation = PngValidation | StlValidation;
/** Validate the PNG container and IHDR dimensions without inflating image/text data.
 * Source: https://www.w3.org/TR/png-3/ (critical chunks, CRC and IHDR).
 * A passing result deliberately does not attest decoded pixels or appearance.
 */
export declare function validatePngContent(bytes: Buffer, expected?: PngExpectation): PngValidation;
/** STL has both ASCII and fixed-record binary encodings; header text is not magic.
 * https://www.iana.org/assignments/media-types/model/stl
 * No mesh-sized arrays, archive extraction or geometry repair are performed.
 */
export declare function validateStlContent(bytes: Buffer): StlValidation;
