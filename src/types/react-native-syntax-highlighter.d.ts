declare module 'react-native-syntax-highlighter' {
  import type { ComponentType } from 'react';

  export interface SyntaxHighlighterProps {
    language?: string;
    style?: unknown;
    customStyle?: Record<string, string>;
    useInlineStyles?: boolean;
    wrapLongLines?: boolean;
    children?: string;
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>;
  export default SyntaxHighlighter;
}
