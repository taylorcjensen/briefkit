export type ColorMode = 'auto' | 'light' | 'dark';

export interface PageConfigEntry {
  file: string;
  title?: string;
  route?: string;
  description?: string;
  image?: string;
}

export type PageConfig = string | PageConfigEntry;

export interface BriefkitConfig {
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  pages?: PageConfig[];
}

export interface HeadingInfo {
  depth: number;
  slug: string;
  text: string;
}

export interface PageInfo {
  file: string;
  absolutePath: string;
  route: string;
  title: string;
  hidden: boolean;
  description?: string;
  image?: string;
  headings: HeadingInfo[];
  layout: 'report' | 'none' | 'custom';
  customLayout?: string;
}

export interface ReportInfo {
  reportDir: string;
  config: BriefkitConfig;
  title: string;
  pages: PageInfo[];
}
