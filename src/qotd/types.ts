export interface ManualMetadata {
  competition: string | null;
  edition: string | null;
  year: number | null;
  level: string | null;
  set: string | null;
  title: string;
}
export interface ParsedQuestion {
  number: number;
  section: string;
  text: string;
  choices: { label: string; text: string }[];
  kind: 'mcq' | 'open';
  officialAnswer: string;
  officialSolution: string;
  questionPage: number;
  questionEndPage: number;
  solutionPage: number | null;
  solutionEndPage: number | null;
  rawQuestion: string;
  rawSolution: string;
  flags: string[];
  questionRange?: { start: { page: number; line: number }; end: { page: number; line: number } | null; separateListing: boolean };
  crop?: QuestionCrop;
  solutionRange?: SolutionRange;
}
// PDF.js text-line anchors, not question-sized pixel rectangles. Null end means
// the final solution continues to the end of solutionEndPage.
export interface SolutionRange {
  start: { page: number; line: number };
  end: { page: number; line: number } | null;
}
export interface SolutionSource {
  sourceId: string;
  number: number;
  solutionPage: number;
  solutionEndPage: number;
  range?: SolutionRange;
}
export interface CropImage {
  path: string;
  sha256: string;
  page: number | null;
  rect: [number, number, number, number] | null;
  width: number;
  height: number;
}
export interface QuestionCrop {
  status: 'generated' | 'failed' | 'override';
  images: CropImage[];
  flags: string[];
}
export interface ParsedManual { metadata: ManualMetadata; questions: ParsedQuestion[]; warnings: string[] }
