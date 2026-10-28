import type { CACHE_MODES } from "./form-defaults";

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

export interface ImageEntry {
  name: string;
  type: string;
  dataUrl: string;
}

export interface MediaReference {
  file: File;
  url: string;
  duration: number;
  frames: string[];
  audio: string;
  useAudio: boolean;
  processing: boolean;
  progress: string;
  error: string;
  audioError: string;
}

export type ImageTarget =
  | "init_image"
  | "mask_image"
  | "control_image"
  | "ip_adapter_image"
  | "end_image"
  | "ref_images"
  | "control_frames";

export type GenerationMode = "image" | "video";

export interface ImageInputConfig {
  target: ImageTarget;
  label: string;
  description: string;
  layout: "grid" | "full";
}

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

export interface GuidanceParams {
  txt_cfg: number;
  img_cfg: string | number;
  distilled_guidance: number;
  slg_layers: string;
  layer_start: number;
  layer_end: number;
  scale: number;
}

export interface SampleParams {
  scheduler: string;
  sample_method: string;
  sample_steps: number;
  eta: string | number;
  shifted_timestep: number;
  flow_shift: string | number;
  guidance: GuidanceParams;
}

export interface VaeTilingParams {
  enabled: boolean;
  tile_size_w: number;
  tile_size_h: number;
  target_overlap: number;
  rel_size_w: number;
  rel_size_h: number;
}

export interface CacheParams {
  mode: string;
  option: string;
  scm_mask: string;
  scm_policy_dynamic: boolean;
}

export interface FormLoraEntry {
  path: string;
  multiplier: number;
  is_high_noise: boolean;
}

export interface GenerationForm {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  batch_count: number;
  video_frames: number;
  fps: number;
  seed: number;
  clip_skip: number;
  strength: number;
  control_strength: number;
  ip_adapter_strength: number;
  moe_boundary: number;
  vace_strength: number;
  output_format: string;
  output_compression: number;
  preview_mode: string;
  preview_interval: number;
  sample_params: SampleParams;
  high_noise_sample_params: SampleParams;
  init_image: ImageEntry | null;
  end_image: ImageEntry | null;
  ref_images: ImageEntry[];
  ref_video: MediaReference | null;
  ref_audio: MediaReference | null;
  control_frames: ImageEntry[];
  mask_image: ImageEntry | null;
  control_image: ImageEntry | null;
  ip_adapter_image: ImageEntry | null;
  lora: FormLoraEntry[];
  vae_tiling_params: VaeTilingParams;
  cache: CacheParams;
}

// ---------------------------------------------------------------------------
// LoRA
// ---------------------------------------------------------------------------

export interface AvailableLora {
  name: string;
  path: string;
  display_path?: string;
}

// ---------------------------------------------------------------------------
// Capabilities (API response)
// ---------------------------------------------------------------------------

export type GenerationFeatures = Record<string, boolean>;

export interface Capabilities {
  generation_features?: GenerationFeatures;
  runtime?: ModelStatus;
  model?: {
    stem?: string;
    name?: string;
  };
  current_mode?: "img_gen" | "vid_gen";
  supported_modes?: Array<"img_gen" | "vid_gen">;
  output_formats?: string[];
  output_formats_by_mode?: Partial<Record<"img_gen" | "vid_gen", string[]>>;
  samplers?: string[];
  schedulers?: string[];
  loras?: AvailableLora[];
  preview_modes?: string[];
  limits?: {
    max_queue_size?: number;
    min_width?: number;
    max_width?: number;
    min_height?: number;
    max_height?: number;
  };
  features?: {
    cancel_queued?: boolean;
    cancel_generating?: boolean;
    preview?: boolean;
  };
  features_by_mode?: Partial<Record<"img_gen" | "vid_gen", Record<string, any>>>;
  defaults?: Record<string, any>;
  defaults_by_mode?: Partial<Record<"img_gen" | "vid_gen", Record<string, any>>>;
}

// ---------------------------------------------------------------------------
// Job (API response)
// ---------------------------------------------------------------------------

export interface ImageOutput {
  index: number;
  b64_json: string;
}

export type JobKind = "img_gen" | "vid_gen";

export interface JobResult {
  images?: ImageOutput[];
  output_format?: string;
  b64_json?: string;
  mime_type?: string;
  fps?: number;
  frame_count?: number;
}

export interface Job {
  id: string;
  kind?: JobKind;
  status: string;
  cancel_requested?: boolean;
  queue_position?: number;
  created?: number;
  started?: number;
  completed?: number;
  result?: JobResult | null;
  preview?: {
    pass: number;
    step: number;
    total_steps: number;
    b64_json: string;
  } | null;
  error?: {
    code?: string;
    message?: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Cache mode literal union
// ---------------------------------------------------------------------------

export type CacheMode = (typeof CACHE_MODES)[number];

export interface ModelStatus {
  state: "empty" | "loading" | "ready" | "error";
  recipe: string | null;
  models: Record<string, string>;
  error: string | null;
  revision?: number;
  origin?: string;
  runtime_recipe?: Recipe;
  load_elapsed_seconds?: number | null;
}
export interface RecipeDefaults {
  strength?: number;
  moe_boundary?: number;
  width?: number;
  height?: number;
  steps?: number;
  custom_sigmas?: number[];
  cfg_scale?: number;
  img_cfg_scale?: number;
  distilled_guidance?: number;
  sampling_method?: string;
  scheduler?: string;
  video_frames?: number;
  fps?: number;
  flow_shift?: number;
  shifted_timestep?: number;
  high_noise_steps?: number;
  high_noise_cfg_scale?: number;
  high_noise_flow_shift?: number;
  high_noise_sampling_method?: string;
  high_noise_scheduler?: string;
}
export interface VideoConstraints {
  frame_step?: number;
  frame_offset?: number;
  frame_rounding?: "floor" | "ceil";
  min_frames?: number;
  max_frames?: number;
  fixed_fps?: number;
}
export interface Recipe {
  id: string;
  name: string;
  description?: string;
  model_url?: string;
  size_multiple?: number;
  video_constraints?: VideoConstraints;
  required_any?: string[][];
  source: "builtin" | "user" | "command_line";
  models?: Record<string, string>;
  defaults?: RecipeDefaults;
  features?: string[];
  disabled_features?: string[];
  effective_features?: GenerationFeatures;
  slots: { id: string; label: string; category: string; categories?: string[]; required: boolean }[];
}
export interface ModelFile { id: string; name?: string; category: string; }
export interface CatalogError { file: string; message: string; }
