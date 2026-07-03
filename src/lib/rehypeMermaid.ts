interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export default function briefkitMermaid() {
  return (tree: HastNode) => {
    transformChildren(tree);
  };
}

function transformChildren(node: HastNode): void {
  if (!node.children) return;

  node.children = node.children.map((child) => {
    const mermaidSource = mermaidSourceFromPre(child);
    if (mermaidSource) return createMermaidFigure(mermaidSource);

    transformChildren(child);
    return child;
  });
}

function mermaidSourceFromPre(node: HastNode): string | undefined {
  if (node.type !== 'element' || node.tagName !== 'pre') return undefined;

  const code = node.children?.find((child) => child.tagName === 'code');
  const isPlainMermaidFence = Boolean(code && hasClass(code, 'language-mermaid'));
  const isHighlightedMermaidFence = propertyValue(node, 'dataLanguage') === 'mermaid'
    || propertyValue(node, 'data-language') === 'mermaid'
    || hasClass(node, 'language-mermaid');

  if (!isPlainMermaidFence && !isHighlightedMermaidFence) return undefined;

  const source = textContent(code ?? node).trim();
  return source.length > 0 ? source : undefined;
}

function createMermaidFigure(source: string): HastNode {
  return {
    type: 'element',
    tagName: 'figure',
    properties: {
      className: ['bk-mermaid'],
      'data-bk-mermaid-source': source,
    },
    children: [
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['bk-mermaid-stage'] },
        children: [
          {
            type: 'element',
            tagName: 'pre',
            properties: { className: ['bk-mermaid-source'] },
            children: [
              {
                type: 'element',
                tagName: 'code',
                properties: {},
                children: [{ type: 'text', value: source }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function propertyValue(node: HastNode, name: string): string | undefined {
  const value = node.properties?.[name];
  return typeof value === 'string' ? value : undefined;
}

function hasClass(node: HastNode, className: string): boolean {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.includes(className);
  if (typeof value === 'string') return value.split(/\s+/).includes(className);
  return false;
}

function textContent(node: HastNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textContent).join('');
}
