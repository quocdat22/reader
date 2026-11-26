/**
 * 1-to-1 TypeScript DTOs matching `src-tauri/src/` IPC structs (`snake_case`).
 */

export type ZoomMode = "fit_width" | "fit_page" | "custom";

export type ErrorCode =
  | "io"
  | "unsupported_format"
  | "password_protected"
  | "invalid_document"
  | "page_out_of_range"
  | "document_not_found"
  | "cancelled"
  | "internal";

export interface ErrorResponse {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface DocumentMetadata {
  readonly title: string | null;
  readonly author: string | null;
  readonly page_count: number;
}

export interface PageDimensions {
  readonly width_pt: number;
  readonly height_pt: number;
}

export interface ReadingPosition {
  readonly page_index: number;
  readonly zoom_mode: ZoomMode;
  readonly zoom_scale: number;
}

export interface RecentFile {
  readonly path: string;
  readonly title: string;
  readonly last_opened_unix: number;
  readonly last_page: number;
  readonly page_count: number;
}

export interface PersistedState {
  readonly version: number;
  readonly recent_files: RecentFile[];
  readonly positions: Record<string, ReadingPosition>;
}

export interface OpenDocumentResponse {
  readonly document_id: number;
  readonly canonical_path: string;
  readonly metadata: DocumentMetadata;
  readonly page_dimensions: PageDimensions[];
  readonly saved_position: ReadingPosition | null;
  readonly already_open: boolean;
}

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OutlineItem {
  readonly title: string;
  readonly page_index: number | null;
  readonly children: OutlineItem[];
}

export interface TextSpan {
  readonly text: string;
  readonly rect: NormalizedRect;
}

export interface SearchMatch {
  readonly page_index: number;
  readonly rects: NormalizedRect[];
}
