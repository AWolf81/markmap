import type * as d3 from 'd3';
import {
  linkHorizontal,
  max,
  min,
  minIndex,
  select,
  zoom,
  zoomIdentity,
  zoomTransform,
  interpolateString,
} from 'd3';
import { flextree } from 'd3-flextree';
import {
  Hook,
  INode,
  IPureNode,
  addClass,
  debounce,
  getId,
  noop,
  walkTree,
} from 'markmap-common';
import { defaultOptions, isMacintosh } from './constants';
import css from './style.css?inline';
import {
  ID3SVGElement,
  IMarkmapOptions,
  IMarkmapState,
  IPadding,
  IViewHooks,
} from './types';
import { childSelector, simpleHash } from './util';

export const globalCSS = css;

const SELECTOR_NODE = 'g.markmap-node';
const SELECTOR_LINK = 'path.markmap-link';
const SELECTOR_HIGHLIGHT = 'g.markmap-highlight';

const linkShape = linkHorizontal();

function minBy(numbers: number[], by: (v: number) => number): number {
  const index = minIndex(numbers, by);
  return numbers[index];
}

function stopPropagation(e: Event) {
  e.stopPropagation();
}

/**
 * A global hook to refresh all markmaps when called.
 */
export const refreshHook = new Hook<[]>();

export class Markmap {
  options = { ...defaultOptions };

  state: IMarkmapState;

  svg: ID3SVGElement;

  styleNode: d3.Selection<HTMLStyleElement, INode, HTMLElement, INode>;

  g: d3.Selection<SVGGElement, INode, HTMLElement, INode>;

  zoom: d3.ZoomBehavior<SVGElement, INode>;

  hooks: IViewHooks = {};

  private _observer: ResizeObserver;

  private _disposeList: (() => void)[] = [];

  private _rootPaddingX = 0;

  private _rootPaddingY = 0;

  private _rootContentHeight = 0;

  constructor(
    svg: string | SVGElement | ID3SVGElement,
    opts?: Partial<IMarkmapOptions>,
  ) {
    this.svg = (svg as ID3SVGElement).datum
      ? (svg as ID3SVGElement)
      : select(svg as string);
    this.styleNode = this.svg.append('style');
    this.zoom = zoom<SVGElement, INode>()
      .filter((event) => {
        if (this.options.scrollForPan) {
          // Pan with wheels, zoom with ctrl+wheels
          if (event.type === 'wheel') return event.ctrlKey && !event.button;
        }
        return (!event.ctrlKey || event.type === 'wheel') && !event.button;
      })
      .on('zoom', this.handleZoom);
    this.setOptions(opts);
    this.state = {
      id: this.options.id || this.svg.attr('id') || getId(),
      rect: { x1: 0, y1: 0, x2: 0, y2: 0 },
    };
    this.g = this.svg.append('g');
    this.g.append('g').attr('class', 'markmap-highlight');
    this._observer = new ResizeObserver(
      debounce(() => {
        this.renderData();
      }, 100),
    );
    this._disposeList.push(
      refreshHook.tap(() => {
        this.setData();
      }),
      () => this._observer.disconnect(),
    );
  }

  getStyleContent(): string {
    const { style } = this.options;
    const { id } = this.state;
    const styleText = typeof style === 'function' ? style(id) : '';
    return [this.options.embedGlobalCSS && css, styleText]
      .filter(Boolean)
      .join('\n');
  }

  updateStyle(): void {
    this.svg.attr(
      'class',
      addClass(this.svg.attr('class'), 'markmap', this.state.id),
    );
    const style = this.getStyleContent();
    this.styleNode.text(style);
  }

  handleZoom = (e: any) => {
    const { transform } = e;
    this.g.attr('transform', transform);
  };

  handlePan = (e: WheelEvent) => {
    e.preventDefault();
    const transform = zoomTransform(this.svg.node()!);
    const newTransform = transform.translate(
      -e.deltaX / transform.k,
      -e.deltaY / transform.k,
    );
    this.svg.call(this.zoom.transform, newTransform);
  };

  async toggleNode(
    data: INode,
    recursive = false,
    side?:
      | 'left'
      | 'right'
      | 'top-left'
      | 'top-right'
      | 'bottom-left'
      | 'bottom-right',
  ) {
    // Multi-directional root special handling
    if (
      side &&
      (data.payload?.hasMultiDirectionalLayout ||
        data.payload?.hasBilateralLayout)
    ) {
      const foldKeyMap: Record<string, string> = {
        left: 'leftFolded',
        right: 'rightFolded',
        'top-left': 'topLeftFolded',
        'top-right': 'topRightFolded',
        'bottom-left': 'bottomLeftFolded',
        'bottom-right': 'bottomRightFolded',
      };
      const foldKey = foldKeyMap[side];
      const newFold = (data.payload[foldKey] as number) ? 0 : 1;

      if (recursive) {
        // Fold all children on this side recursively
        const allChildren = data.payload._allChildren as INode[] | undefined;
        allChildren?.forEach((child) => {
          if (child.payload?.direction === side) {
            walkTree(child, (item, next) => {
              item.payload = { ...item.payload, fold: newFold };
              next();
            });
          }
        });
      }

      data.payload = { ...data.payload, [foldKey]: newFold };
      await this.renderData(data);
      return;
    }

    // Default behavior for normal nodes
    const fold = data.payload?.fold ? 0 : 1;
    if (recursive) {
      // recursively
      walkTree(data, (item, next) => {
        item.payload = {
          ...item.payload,
          fold,
        };
        next();
      });
    } else {
      data.payload = {
        ...data.payload,
        fold: data.payload?.fold ? 0 : 1,
      };
    }
    await this.renderData(data);
  }

  handleClick = (
    e: MouseEvent,
    d:
      | INode
      | {
          node: INode;
          side:
            | 'left'
            | 'right'
            | 'top-left'
            | 'top-right'
            | 'bottom-left'
            | 'bottom-right'
            | 'default';
        },
  ) => {
    let recursive = this.options.toggleRecursively;
    if (isMacintosh ? e.metaKey : e.ctrlKey) recursive = !recursive;

    // Handle multi-directional circle clicks
    if (typeof d === 'object' && 'node' in d) {
      const { node, side } = d;
      if (side !== 'default') {
        this.toggleNode(node, recursive, side);
        return;
      }
      this.toggleNode(node, recursive);
      return;
    }

    // Default behavior for regular nodes
    this.toggleNode(d, recursive);
  };

  private isRootFullyFolded(root: INode): boolean {
    if (
      root.payload?.hasMultiDirectionalLayout ||
      root.payload?.hasBilateralLayout
    ) {
      const dirKeys: Record<string, keyof typeof root.payload> = {
        left: 'leftFolded',
        right: 'rightFolded',
        'top-left': 'topLeftFolded',
        'top-right': 'topRightFolded',
        'bottom-left': 'bottomLeftFolded',
        'bottom-right': 'bottomRightFolded',
      };
      const directions = (root.children || []).map(
        (c) => c.payload?.direction || 'right',
      );
      if (!directions.length) return true;
      return directions.every((dir) => !!(root.payload?.[dirKeys[dir]] as any));
    }
    return !!root.payload?.fold;
  }

  private shouldShowMasterToggle(root: INode): boolean {
    if (
      !(
        root.payload?.hasMultiDirectionalLayout ||
        root.payload?.hasBilateralLayout
      )
    ) {
      return false;
    }
    const dirKeys: Array<
      | 'leftChildrenCount'
      | 'rightChildrenCount'
      | 'topLeftChildrenCount'
      | 'topRightChildrenCount'
      | 'bottomLeftChildrenCount'
      | 'bottomRightChildrenCount'
    > = [
      'leftChildrenCount',
      'rightChildrenCount',
      'topLeftChildrenCount',
      'topRightChildrenCount',
      'bottomLeftChildrenCount',
      'bottomRightChildrenCount',
    ];
    const dirCount = dirKeys.reduce((count, key) => {
      const has = (root.payload?.[key] as number) > 0;
      return has ? count + 1 : count;
    }, 0);
    // Fallback: count unique directions on the full child list if counts are missing
    const allChildren =
      (root.payload?._allChildren as INode[] | undefined) ||
      root.children ||
      [];
    const childDirCount =
      dirCount ||
      new Set(
        allChildren.map((c) => c.payload?.direction || 'right').filter(Boolean),
      ).size;
    return childDirCount > 1;
  }

  private handleMasterToggle = (e: MouseEvent, root: INode) => {
    let recursive = this.options.toggleRecursively;
    if (isMacintosh ? e.metaKey : e.ctrlKey) recursive = !recursive;

    const targetFold = this.isRootFullyFolded(root) ? 0 : 1;

    if (
      root.payload?.hasMultiDirectionalLayout ||
      root.payload?.hasBilateralLayout
    ) {
      const dirKeys: Record<string, keyof typeof root.payload> = {
        left: 'leftFolded',
        right: 'rightFolded',
        'top-left': 'topLeftFolded',
        'top-right': 'topRightFolded',
        'bottom-left': 'bottomLeftFolded',
        'bottom-right': 'bottomRightFolded',
      };
      const allChildren =
        (root.payload?._allChildren as INode[] | undefined) ||
        root.children ||
        [];
      const directions = allChildren.map(
        (c) => c.payload?.direction || 'right',
      );
      const payload = { ...root.payload };
      directions.forEach((dir) => {
        const key = dirKeys[dir];
        payload[key] = targetFold;
      });
      root.payload = payload;

      if (recursive) {
        allChildren.forEach((child) => {
          walkTree(child, (item, next) => {
            item.payload = { ...item.payload, fold: targetFold };
            next();
          });
        });
      }
    } else {
      walkTree(root, (item, next) => {
        item.payload = { ...item.payload, fold: targetFold };
        next();
      });
    }

    this.renderData(root);
  };

  private _initializeData(node: IPureNode | INode) {
    let nodeId = 0;
    const { color, initialExpandLevel } = this.options;

    let foldRecursively = 0;
    let depth = 0;
    walkTree(node as INode, (item, next, parent) => {
      depth += 1;
      item.children = item.children?.map((child) => ({ ...child }));
      nodeId += 1;
      item.state = {
        ...item.state,
        depth,
        id: nodeId,
        rect: {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        size: [0, 0],
      };
      item.state.key =
        [parent?.state?.id, item.state.id].filter(Boolean).join('.') +
        simpleHash(item.content);
      item.state.path = [parent?.state?.path, item.state.id]
        .filter(Boolean)
        .join('.');
      color(item); // preload colors

      const isFoldRecursively = item.payload?.fold === 2;
      if (isFoldRecursively) {
        foldRecursively += 1;
      } else if (
        foldRecursively ||
        (initialExpandLevel >= 0 && item.state.depth >= initialExpandLevel)
      ) {
        item.payload = { ...item.payload, fold: 1 };
      }
      next();
      if (isFoldRecursively) foldRecursively -= 1;
      depth -= 1;
    });

    return node as INode;
  }

  private _relayout() {
    if (!this.state.data) return;

    // Note: beforeLayout hook is now called in renderData() before walkTree
    // to allow plugins to filter children before collecting nodes

    this.g
      .selectAll<SVGGElement, INode>(childSelector<SVGGElement>(SELECTOR_NODE))
      .selectAll<SVGForeignObjectElement, INode>(
        childSelector<SVGForeignObjectElement>('foreignObject'),
      )
      .each(function (d) {
        const el = this.firstChild?.firstChild as HTMLDivElement;
        const newSize: [number, number] = [el.scrollWidth, el.scrollHeight];
        d.state.size = newSize;
      });

    const { lineWidth, paddingX, spacingHorizontal, spacingVertical } =
      this.options;
    const layout = flextree<INode>({})
      .children((d) => {
        if (d.payload?.fold) return undefined;
        return d.children;
      })
      .nodeSize((node) => {
        const [width, height] = node.data.state.size;
        return [height, width + (width ? paddingX * 2 : 0) + spacingHorizontal];
      })
      .spacing((a, b) => {
        return (
          (a.parent === b.parent ? spacingVertical : spacingVertical * 2) +
          lineWidth(a.data)
        );
      });

    const applyLayout = (rootNode: INode, excludeRoot = false): INode[] => {
      const tree = layout.hierarchy(rootNode);
      layout(tree);
      const descendants = tree.descendants();
      descendants.forEach((fnode) => {
        const node = fnode.data;
        node.state.rect = {
          x: fnode.y,
          y: fnode.x - fnode.xSize / 2,
          width: fnode.ySize - spacingHorizontal,
          height: fnode.xSize,
        };
      });
      const mapped = descendants.map((d) => d.data);
      return excludeRoot ? mapped.filter((n) => n !== rootNode) : mapped;
    };

    let fnodes: INode[] = [];
    const rootNode = this.state.data;
    const rootHasMulti = !!rootNode?.payload?.hasMultiDirectionalLayout;
    const rootHasBilateral = !!rootNode?.payload?.hasBilateralLayout;

    // Compute and store root padding for this render
    const rootPaddingX =
      rootHasMulti || rootHasBilateral ? Math.max(12, paddingX * 0.8) : 0;
    const rootPaddingY = rootHasMulti || rootHasBilateral ? 10 : 0;
    this._rootPaddingX = rootPaddingX;
    this._rootPaddingY = rootPaddingY;
    this._rootContentHeight = (rootNode?.state?.size?.[1] as number) || 0;
    this._rootContentHeight = (rootNode?.state?.size?.[1] as number) || 0;

    if (rootNode?.payload?.hasMultiDirectionalLayout && rootNode.children) {
      // Split children into 6 groups based on direction
      const leftChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'left',
      );
      const rightChildren = rootNode.children.filter(
        (c) =>
          c.payload?.direction === 'right' ||
          (!c.payload?.direction && c.payload?.direction !== 'left'),
      );
      const topLeftChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'top-left',
      );
      const topRightChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'top-right',
      );
      const bottomLeftChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'bottom-left',
      );
      const bottomRightChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'bottom-right',
      );

      // Apply horizontal layout for left and right
      if (leftChildren.length) {
        const leftRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: leftChildren,
        };
        fnodes.push(...applyLayout(leftRoot, true));
      }
      if (rightChildren.length) {
        const rightRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: rightChildren,
        };
        fnodes.push(...applyLayout(rightRoot, true));
      }

      // Apply layout for vertical directions (they will be transformed in afterLayout hook)
      if (topLeftChildren.length) {
        const topLeftRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: topLeftChildren,
        };
        fnodes.push(...applyLayout(topLeftRoot, true));
      }
      if (topRightChildren.length) {
        const topRightRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: topRightChildren,
        };
        fnodes.push(...applyLayout(topRightRoot, true));
      }
      if (bottomLeftChildren.length) {
        const bottomLeftRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: bottomLeftChildren,
        };
        fnodes.push(...applyLayout(bottomLeftRoot, true));
      }
      if (bottomRightChildren.length) {
        const bottomRightRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: bottomRightChildren,
        };
        fnodes.push(...applyLayout(bottomRightRoot, true));
      }

      // Set root rect independently based on its content only
      const [rootW, rootH] = rootNode.state.size;
      const rootWidth = rootW + (rootW ? paddingX * 2 : 0) + rootPaddingX * 2;
      // Add padding above and below for top border and circles
      const rootHeight = rootH + rootPaddingY * 2;
      rootNode.state.rect = {
        x: -rootWidth / 2,
        y: -rootHeight / 2,
        width: rootWidth,
        height: rootHeight,
      };
      fnodes.push(rootNode);
    } else if (rootNode?.payload?.hasBilateralLayout && rootNode.children) {
      // Backwards compatibility for bilateral layout
      const leftChildren = rootNode.children.filter(
        (c) => c.payload?.direction === 'left',
      );
      const rightChildren = rootNode.children.filter(
        (c) => c.payload?.direction !== 'left',
      );

      if (leftChildren.length) {
        const leftRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: leftChildren,
        };
        fnodes.push(...applyLayout(leftRoot, true));
      }
      if (rightChildren.length) {
        const rightRoot = {
          ...rootNode,
          state: { ...rootNode.state },
          children: rightChildren,
        };
        fnodes.push(...applyLayout(rightRoot, true));
      }

      // Set root rect independently based on its content only
      const [rootW, rootH] = rootNode.state.size;
      const rootWidth = rootW + (rootW ? paddingX * 2 : 0) + rootPaddingX * 2;
      // Add padding above and below for top border and circles
      const rootHeight = rootH + rootPaddingY * 2;
      rootNode.state.rect = {
        x: -rootWidth / 2,
        y: -rootHeight / 2,
        width: rootWidth,
        height: rootHeight,
      };
      fnodes.push(rootNode);
    } else {
      const tree = layout.hierarchy(this.state.data);
      layout(tree);
      const d = tree.descendants();
      d.forEach((fnode) => {
        const node = fnode.data;
        node.state.rect = {
          x:
            fnode.y +
            (node === rootNode && (rootHasMulti || rootHasBilateral)
              ? -rootPaddingX
              : 0),
          y: fnode.x - fnode.xSize / 2 - (node === rootNode ? rootPaddingY : 0),
          width:
            fnode.ySize -
            spacingHorizontal +
            (node === rootNode ? rootPaddingX * 2 : 0),
          height: fnode.xSize + (node === rootNode ? rootPaddingY * 2 : 0),
        };
      });
      fnodes = d.map((f) => f.data);
    }

    // Call afterLayout hook for plugins
    this.hooks.afterLayout?.(fnodes, this.options);

    this.state.rect = {
      x1: min(fnodes, (fnode) => fnode.state.rect.x) || 0,
      y1: min(fnodes, (fnode) => fnode.state.rect.y) || 0,
      x2:
        max(fnodes, (fnode) => fnode.state.rect.x + fnode.state.rect.width) ||
        0,
      y2:
        max(fnodes, (fnode) => fnode.state.rect.y + fnode.state.rect.height) ||
        0,
    };
  }

  /**
   * Register hooks for plugins to control layout and rendering.
   */
  registerHooks(hooks: IViewHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  private _getBaselineY(node: INode): number {
    const { lineWidth } = this.options;
    const contentHeight =
      (node.state.size?.[1] as number) || node.state.rect.height;
    const isRoot = node.state.depth === 1;
    const isPaddedRoot =
      isRoot &&
      (node.payload?.hasMultiDirectionalLayout ||
        node.payload?.hasBilateralLayout);

    // Only the root needs extra clearance for the multiple toggle circles.
    if (isRoot) {
      const paddingBelow = isPaddedRoot ? this._rootPaddingY / 2 : 0;
      const gap = Math.max(4, lineWidth(node));
      return contentHeight + paddingBelow + gap;
    }

    // All other nodes keep the standard baseline just below their content.
    return contentHeight + lineWidth(node) / 2;
  }

  setOptions(opts?: Partial<IMarkmapOptions>): void {
    const hasAlternateLayout =
      opts &&
      Object.prototype.hasOwnProperty.call(opts as any, 'alternateLayout');
    const next: any = {
      ...this.options,
      ...opts,
    };
    // Drop stale plugin-specific options (e.g., alternateLayout) when not provided
    if (!hasAlternateLayout) delete next.alternateLayout;
    this.options = next;
    if (this.options.zoom) {
      this.svg.call(this.zoom);
    } else {
      this.svg.on('.zoom', null);
    }
    if (this.options.pan) {
      this.svg.on('wheel', this.handlePan);
    } else {
      this.svg.on('wheel', null);
    }
  }

  async setData(data?: IPureNode | null, opts?: Partial<IMarkmapOptions>) {
    if (opts) this.setOptions(opts);
    if (data) {
      this.state.data = this._initializeData(data);
    }
    if (!this.state.data) return;
    this.updateStyle();
    await this.renderData();
  }

  async setHighlight(node?: INode | null) {
    this.state.highlight = node || undefined;
    await this.renderData();
  }

  private _getHighlightRect(highlight: INode) {
    const svgNode = this.svg.node()!;
    const transform = zoomTransform(svgNode);
    const padding = 4 / transform.k;
    const rect = {
      ...highlight.state.rect,
    };
    rect.x -= padding;
    rect.y -= padding;
    rect.width += 2 * padding;
    rect.height += 2 * padding;
    return rect;
  }

  async renderData(originData?: INode) {
    const { paddingX, autoFit, color, maxWidth, lineWidth } = this.options;
    const rootNode = this.state.data;
    if (!rootNode) return;

    // Calculate root padding early (needed for foreignObject positioning)
    const rootHasMulti = !!rootNode?.payload?.hasMultiDirectionalLayout;
    const rootHasBilateral = !!rootNode?.payload?.hasBilateralLayout;
    this._rootPaddingX =
      rootHasMulti || rootHasBilateral ? Math.max(12, paddingX * 0.8) : 0;
    this._rootPaddingY =
      rootHasMulti || rootHasBilateral ? Math.max(6, lineWidth(rootNode)) : 0;

    // Call beforeLayout hook BEFORE collecting nodes
    // This allows plugins to filter children before walkTree runs
    this.hooks.beforeLayout?.(rootNode, this.options);

    const nodeMap: Record<number, INode> = {};
    const parentMap: Record<number, number> = {};
    const nodes: INode[] = [];
    walkTree(rootNode, (item, next, parent) => {
      if (!item.payload?.fold) next();

      nodeMap[item.state.id] = item;
      if (parent) parentMap[item.state.id] = parent.state.id;
      nodes.push(item);
    });

    const originMap: Record<number, number> = {};
    const sourceRectMap: Record<
      number,
      { x: number; y: number; width: number; height: number }
    > = {};
    const setOriginNode = (originNode: INode | undefined) => {
      if (!originNode || originMap[originNode.state.id]) return;
      walkTree(originNode, (item, next) => {
        originMap[item.state.id] = originNode.state.id;
        next();
      });
    };
    const getOriginSourceRect = (node: INode) => {
      const rect = sourceRectMap[originMap[node.state.id]];
      return rect || rootNode.state.rect;
    };
    const getOriginTargetRect = (node: INode) =>
      (nodeMap[originMap[node.state.id]] || rootNode).state.rect;
    const getCollapseParentRect = (node: INode) => {
      const originId = originMap[node.state.id];
      if (originId && sourceRectMap[originId]) return sourceRectMap[originId];
      const parentId = parentMap[node.state.id];
      if (parentId && sourceRectMap[parentId]) return sourceRectMap[parentId];
      return sourceRectMap[rootNode.state.id] || rootNode.state.rect;
    };
    const getCollapseAnchor = (
      parent: INode,
      child: INode,
      parentRect: { x: number; y: number; width: number; height: number },
    ): [number, number] => {
      const dir = child.payload?.direction;
      const baseline = this._getBaselineY(parent);

      if (dir === 'left') return [parentRect.x, parentRect.y + baseline];
      if (dir === 'right')
        return [parentRect.x + parentRect.width, parentRect.y + baseline];
      if (dir === 'top-left')
        return [parentRect.x + parentRect.width * 0.3, parentRect.y];
      if (dir === 'top-right')
        return [parentRect.x + parentRect.width * 0.7, parentRect.y];
      if (dir === 'bottom-left')
        return [parentRect.x + parentRect.width * 0.3, parentRect.y + baseline];
      if (dir === 'bottom-right')
        return [parentRect.x + parentRect.width * 0.7, parentRect.y + baseline];

      const targetOnLeft =
        (child.state?.rect?.x ?? 0) < (parent.state?.rect?.x ?? 0);
      return targetOnLeft
        ? [parentRect.x, parentRect.y + baseline]
        : [parentRect.x + parentRect.width, parentRect.y + baseline];
    };

    const buildLinkPath = (
      sourceNode: INode,
      targetNode: INode,
      sourceRectOverride?: {
        x: number;
        y: number;
        width: number;
        height: number;
      },
      targetRectOverride?: {
        x: number;
        y: number;
        width: number;
        height: number;
      },
    ): string | undefined => {
      const sourceRect = sourceRectOverride || sourceNode.state.rect;
      const targetRect = targetRectOverride || targetNode.state.rect;

      // Only allow custom link hook when using live layout rects
      if (!sourceRectOverride && !targetRectOverride) {
        const customLink = this.hooks.renderLink?.(
          sourceNode,
          targetNode,
          this.options,
        );
        if (customLink) return customLink;
      }

      const sourceBaseline = this._getBaselineY(sourceNode);
      const targetBaseline = this._getBaselineY(targetNode);
      const targetDirection = targetNode.payload?.direction as string;
      const isVerticalTarget =
        targetDirection?.startsWith('top-') ||
        targetDirection?.startsWith('bottom-');

      let source: [number, number];
      let target: [number, number];

      if (isVerticalTarget) {
        const targetDepth = targetNode.state?.depth || 0;
        const isDirectChild = targetDepth === 2;
        const isTop = targetDirection.startsWith('top-');
        const isLeft = targetDirection.endsWith('-left');

        if (isDirectChild) {
          const sourceX = isLeft
            ? sourceRect.x + sourceRect.width * 0.3
            : sourceRect.x + sourceRect.width * 0.7;
          const sourceY = isTop ? sourceRect.y : sourceRect.y + sourceBaseline;

          const targetOnLeft = targetRect.x < sourceRect.x;
          const targetX = targetOnLeft
            ? targetRect.x + targetRect.width
            : targetRect.x;
          const targetY = targetRect.y + targetBaseline;
          return (
            linkShape({
              source: [sourceX, sourceY],
              target: [targetX, targetY],
            }) || undefined
          );
        }

        const targetOnLeft = targetRect.x < sourceRect.x;
        if (targetOnLeft) {
          source = [sourceRect.x, sourceRect.y + sourceBaseline];
          target = [
            targetRect.x + targetRect.width,
            targetRect.y + targetBaseline,
          ];
        } else {
          source = [
            sourceRect.x + sourceRect.width,
            sourceRect.y + sourceBaseline,
          ];
          target = [targetRect.x, targetRect.y + targetBaseline];
        }
      } else {
        const sourceOnLeft = sourceRect.x < 0;
        const targetOnLeft = targetRect.x < 0;

        if (targetOnLeft && sourceOnLeft) {
          source = [sourceRect.x, sourceRect.y + sourceBaseline];
          target = [
            targetRect.x + targetRect.width,
            targetRect.y + targetBaseline,
          ];
        } else if (targetOnLeft && !sourceOnLeft) {
          source = [sourceRect.x, sourceRect.y + sourceBaseline];
          target = [
            targetRect.x + targetRect.width,
            targetRect.y + targetBaseline,
          ];
        } else {
          source = [
            sourceRect.x + sourceRect.width,
            sourceRect.y + sourceBaseline,
          ];
          target = [targetRect.x, targetRect.y + targetBaseline];
        }
      }

      return linkShape({ source, target }) || undefined;
    };
    sourceRectMap[rootNode.state.id] = rootNode.state.rect;
    if (originData) setOriginNode(originData);

    // Update highlight
    let { highlight } = this.state;
    if (highlight && !nodeMap[highlight.state.id]) highlight = undefined;
    let highlightNodes = this.g
      .selectAll(childSelector(SELECTOR_HIGHLIGHT))
      .selectAll<SVGRectElement, INode>(childSelector<SVGRectElement>('rect'))
      .data(highlight ? [this._getHighlightRect(highlight)] : [])
      .join('rect')
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y)
      .attr('width', (d) => d.width)
      .attr('height', (d) => d.height);

    // Update the nodes
    const mmG = this.g
      .selectAll<SVGGElement, INode>(childSelector<SVGGElement>(SELECTOR_NODE))
      .each((d) => {
        // Save the current rects before updating nodes
        sourceRectMap[d.state.id] = d.state.rect;
      })
      .data(nodes, (d) => d.state.key);
    const mmGEnter = mmG
      .enter()
      .append('g')
      .attr('data-depth', (d) => d.state.depth)
      .attr('data-path', (d) => d.state.path)
      .each((d) => {
        setOriginNode(nodeMap[parentMap[d.state.id]]);
      });
    const mmGExit = mmG.exit<INode>().each((d) => {
      setOriginNode(nodeMap[parentMap[d.state.id]]);
    });
    const mmGMerge = mmG
      .merge(mmGEnter)
      .attr('class', (d) =>
        ['markmap-node', d.payload?.fold && 'markmap-fold']
          .filter(Boolean)
          .join(' '),
      );

    // Update lines/borders under the content
    // All nodes get an underline
    // Bilateral/multi-directional root nodes also get a top border line
    const mmLine = mmGMerge
      .selectAll<SVGLineElement, INode>(childSelector<SVGLineElement>('line'))
      .data(
        (d) => [d],
        (d) => d?.state?.key || '',
      );
    const mmLineEnter = mmLine
      .enter()
      .append('line')
      .attr('stroke', (d) => color(d))
      .attr('stroke-width', 0);
    const mmLineMerge = mmLine.merge(mmLineEnter);

    // Add top border for bilateral/multi-directional root node
    const rootBorderHasMulti =
      !!this.state.data?.payload?.hasMultiDirectionalLayout;
    const rootBorderHasBilateral =
      !!this.state.data?.payload?.hasBilateralLayout;
    const rootBorderData =
      rootBorderHasMulti || rootBorderHasBilateral
        ? [{ node: this.state.data, pos: 'top' as const }]
        : [];
    const mmRootBorders = mmGMerge
      .selectAll<
        SVGLineElement,
        { node: INode; pos: 'top' | 'bottom' }
      >('line.markmap-root-border')
      .data(
        (d) => (d.state.depth === 1 ? rootBorderData : []),
        (d) =>
          d?.node?.state?.key
            ? `${d.node.state.key}-${d.pos}`
            : `root-border-${d?.pos || 'unknown'}`,
      );
    mmRootBorders
      .enter()
      .append('line')
      .attr('class', 'markmap-root-border')
      .attr('stroke-width', 0);

    // Circle to link to children of the node
    // For multi-directional layout, we can have up to 6 circles
    type CircleData = {
      node: INode;
      side:
        | 'left'
        | 'right'
        | 'top-left'
        | 'top-right'
        | 'bottom-left'
        | 'bottom-right'
        | 'default';
    };
    const mmCircle = mmGMerge
      .selectAll<
        SVGCircleElement,
        CircleData
      >(childSelector<SVGCircleElement>('circle'))
      .data(
        (d): CircleData[] => {
          // Special case: multi-directional root gets up to 6 circles
          if (d.payload?.hasMultiDirectionalLayout) {
            const circles: CircleData[] = [];
            if ((d.payload.leftChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'left' });
            }
            if ((d.payload.rightChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'right' });
            }
            if ((d.payload.topLeftChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'top-left' });
            }
            if ((d.payload.topRightChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'top-right' });
            }
            if ((d.payload.bottomLeftChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'bottom-left' });
            }
            if ((d.payload.bottomRightChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'bottom-right' });
            }
            return circles;
          }

          // Backwards compatibility: bilateral root gets two circles
          if (d.payload?.hasBilateralLayout) {
            const circles: CircleData[] = [];
            if ((d.payload.leftChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'left' });
            }
            if ((d.payload.rightChildrenCount as number) > 0) {
              circles.push({ node: d, side: 'right' });
            }
            return circles;
          }

          if (!d.children?.length) return [];

          // Normal nodes get one circle
          return [{ node: d, side: 'default' }];
        },
        (d) => `${d.node.state.key}-${d.side}`,
      );
    const mmCircleEnter = mmCircle
      .enter()
      .append('circle')
      .attr('stroke-width', 0)
      .attr('r', 0)
      .on('click', (e, d) => this.handleClick(e, d))
      .on('mousedown', stopPropagation);
    const mmCircleMerge = mmCircleEnter
      .merge(mmCircle)
      .attr('stroke', (d) => color(d.node))
      .attr('fill', (d) => {
        const node = d.node;
        // For multi-directional layout, check the appropriate fold state
        const foldStateMap: Record<string, string> = {
          left: 'leftFolded',
          right: 'rightFolded',
          'top-left': 'topLeftFolded',
          'top-right': 'topRightFolded',
          'bottom-left': 'bottomLeftFolded',
          'bottom-right': 'bottomRightFolded',
        };

        if (d.side in foldStateMap) {
          const foldKey = foldStateMap[d.side];
          return ((node.payload?.[foldKey] as number) ?? 0)
            ? color(node)
            : 'var(--markmap-circle-open-bg)';
        }

        // Default behavior
        return node.payload?.fold && node.children
          ? color(node)
          : 'var(--markmap-circle-open-bg)';
      });

    const observer = this._observer;
    const mmFo = mmGMerge
      .selectAll<
        SVGForeignObjectElement,
        INode
      >(childSelector<SVGForeignObjectElement>('foreignObject'))
      .data(
        // Don't render foreignObject for branch nodes (they have no content to display)
        (d) => (d.payload?.isBranchNode ? [] : [d]),
        (d) => d.state.key,
      );
    const mmFoEnter = mmFo
      .enter()
      .append('foreignObject')
      .attr('class', 'markmap-foreign')
      .attr('x', (d) =>
        d.state.depth === 1 &&
        (d.payload?.hasMultiDirectionalLayout || d.payload?.hasBilateralLayout)
          ? paddingX + this._rootPaddingX
          : paddingX,
      )
      .attr('y', 0)
      .style('opacity', 0)
      .on('mousedown', stopPropagation)
      .on('dblclick', stopPropagation);
    mmFoEnter
      // The outer `<div>` with a width of `maxWidth`
      .append<HTMLDivElement>('xhtml:div')
      // The inner `<div>` with `display: inline-block` to get the proper width
      .append<HTMLDivElement>('xhtml:div')
      .style('text-align', (d) => {
        const hasMulti =
          d.state.depth === 1 &&
          (d.payload?.hasMultiDirectionalLayout ||
            d.payload?.hasBilateralLayout);
        return hasMulti ? 'center' : null;
      })
      .html((d) => d.content)
      .attr('xmlns', 'http://www.w3.org/1999/xhtml');
    mmFoEnter.each(function () {
      const el = this.firstChild?.firstChild as Element;
      observer.observe(el);
    });
    const mmFoExit = mmGExit.selectAll<SVGForeignObjectElement, INode>(
      childSelector<SVGForeignObjectElement>('foreignObject'),
    );
    mmFoExit.each(function () {
      const el = this.firstChild?.firstChild as Element;
      observer.unobserve(el);
    });
    const mmFoMerge = mmFoEnter.merge(mmFo);

    // Update the links
    const links = nodes.flatMap((node) =>
      node.payload?.fold
        ? []
        : (node.children || []).map((child) => ({
            source: node,
            target: child,
          })),
    );
    const mmPath = this.g
      .selectAll<
        SVGPathElement,
        { source: INode; target: INode }
      >(childSelector<SVGPathElement>(SELECTOR_LINK))
      .data(links, (d) => d.target.state.key);
    const mmPathExit = mmPath.exit<{ source: INode; target: INode }>();
    const mmPathEnter = mmPath
      .enter()
      .insert('path', 'g')
      .attr('class', 'markmap-link')
      .attr('data-depth', (d) => d.target.state.depth)
      .attr('data-path', (d) => d.target.state.path)
      .attr('d', (d) => {
        const parentRect = getCollapseParentRect(d.target);
        const anchor = getCollapseAnchor(d.source, d.target, parentRect);
        return linkShape({ source: anchor, target: anchor });
      })
      .attr('stroke-width', 0);
    const mmPathMerge = mmPathEnter.merge(mmPath);

    this.svg.style(
      '--markmap-max-width',
      maxWidth ? `${maxWidth}px` : (null as any),
    );
    await new Promise(requestAnimationFrame);
    // Note: d.state.rect is only available after relayout
    this._relayout();

    highlightNodes = highlightNodes
      .data(highlight ? [this._getHighlightRect(highlight)] : [])
      .join('rect');
    this.transition(highlightNodes)
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y)
      .attr('width', (d) => d.width)
      .attr('height', (d) => d.height);

    mmGEnter.attr('transform', (d) => {
      const originRect = getOriginSourceRect(d);
      return `translate(${originRect.x + originRect.width - d.state.rect.width},${
        originRect.y + originRect.height - d.state.rect.height
      })`;
    });
    this.transition(mmGExit)
      .attr('transform', (d) => {
        const targetRect = getOriginTargetRect(d);
        const targetX = targetRect.x + targetRect.width - d.state.rect.width;
        const targetY = targetRect.y + targetRect.height - d.state.rect.height;
        return `translate(${targetX},${targetY})`;
      })
      .remove();

    this.transition(mmGMerge).attr(
      'transform',
      (d) => `translate(${d.state.rect.x},${d.state.rect.y})`,
    );

    const mmLineExit = mmGExit.selectAll<SVGLineElement, INode>(
      childSelector<SVGLineElement>('line'),
    );
    this.transition(mmLineExit)
      .attr('x1', (d) => d?.state?.rect?.width || 0)
      .attr('stroke-width', 0);
    mmLineEnter
      .attr('x1', (d) => d.state.rect.width)
      .attr('x2', (d) => d.state.rect.width);
    const rootBaselineY = this._getBaselineY(rootNode);
    mmLineMerge
      .attr('y1', (d) => this._getBaselineY(d))
      .attr('y2', (d) => this._getBaselineY(d));
    this.transition(mmLineMerge)
      .attr('x1', -1)
      .attr('x2', (d) => d.state.rect.width + 2)
      .attr('stroke', (d) => color(d))
      .attr('stroke-width', lineWidth);
    this.transition(mmRootBorders)
      .style('pointer-events', 'none')
      .attr('x1', () => 0)
      .attr('x2', (d) => d.node.state.rect.width)
      .attr('y1', (d) => {
        if (!d.node) return 0;
        if (d.pos === 'top') return 0;
        return rootBaselineY;
      })
      .attr('y2', (d) => {
        if (!d.node) return 0;
        if (d.pos === 'top') return 0;
        return rootBaselineY;
      })
      .attr('stroke', (d) => color(d.node))
      .attr('stroke-width', (d) => lineWidth(d.node));
    this.transition(mmRootBorders.exit()).attr('stroke-width', 0).remove();

    const mmCircleExit = mmGExit.selectAll<SVGCircleElement, CircleData>(
      childSelector<SVGCircleElement>('circle'),
    );
    this.transition(mmCircleExit).attr('r', 0).attr('stroke-width', 0);
    mmCircleMerge
      // Place circles on the edge that connects to the parent
      // For multi-directional root: circles on all edges
      .attr('cx', (d) => {
        if (d.side === 'left') return 0;
        if (d.side === 'right') return d.node.state.rect.width;
        if (d.side === 'top-left') return d.node.state.rect.width * 0.3;
        if (d.side === 'top-right') return d.node.state.rect.width * 0.7;
        if (d.side === 'bottom-left') return d.node.state.rect.width * 0.3;
        if (d.side === 'bottom-right') return d.node.state.rect.width * 0.7;
        // Default behavior: place on appropriate edge based on position
        return d.node.state.rect.x < 0 ? 0 : d.node.state.rect.width;
      })
      .attr('cy', (d) => {
        if (d.side === 'top-left' || d.side === 'top-right') {
          // Attach to top border line at y=0
          return 0;
        }

        // Place baseline circles using calculated baseline (keeps baselines aligned)
        return this._getBaselineY(d.node);
      });
    this.transition(mmCircleMerge).attr('r', 6).attr('stroke-width', '1.5');

    // Master toggle chevron for root nodes (collapse/expand all)
    const masterToggle = mmGMerge
      .selectAll<SVGGElement, INode>('g.markmap-master-toggle')
      .data(
        (d) =>
          d.state.depth === 1 && this.shouldShowMasterToggle(d) ? [d] : [],
        (d) => d.state.key,
      );
    const masterEnter = masterToggle
      .enter()
      .append('g')
      .attr('class', 'markmap-master-toggle')
      .style('opacity', 0)
      .style('cursor', 'pointer')
      .on('click', (e, d) => this.handleMasterToggle(e, d))
      .on('mousedown', stopPropagation);
    masterEnter
      .append('rect')
      .attr('class', 'markmap-master-hit')
      .attr('x', -6)
      .attr('y', -8)
      .attr('width', 16)
      .attr('height', 16)
      .attr('fill', 'transparent')
      .style('pointer-events', 'all');
    masterEnter.append('path').attr('fill', 'none').attr('stroke-width', 1.5);
    const masterMerge = masterEnter.merge(masterToggle as any);

    masterMerge.attr('transform', (d) => {
      const hasMulti =
        d.payload?.hasMultiDirectionalLayout || d.payload?.hasBilateralLayout;
      const textWidth = d.state.size?.[0] || d.state.rect.width;
      const textHeight = d.state.size?.[1] || d.state.rect.height;
      const textStartX = hasMulti ? paddingX + this._rootPaddingX : paddingX;
      const y = (hasMulti ? this._rootPaddingY / 2 : 0) + textHeight * 0.5;
      const x = textStartX + textWidth + paddingX * 0.9;
      return `translate(${x},${y})`;
    });
    masterMerge
      .select('path')
      .attr('stroke', (d) => color(d))
      .attr('d', (d) => {
        const folded = this.isRootFullyFolded(d);
        // Right chevron when expanded (folded=false), Down chevron when folded=true
        return folded ? 'M -5 -1 L 0 5 L 5 -1' : 'M -4 -4 L 2 0 L -4 4';
      })
      .style('opacity', (d) => ((d.state.size?.[0] || 0) > 0 ? 1 : 0));
    this.transition(masterMerge).style('opacity', (d) =>
      (d.state.size?.[0] || 0) > 0 ? 1 : 0,
    );
    const masterExit = masterToggle.exit<SVGGElement, INode>();
    this.transition(masterExit).style('opacity', 0).remove();

    this.transition(mmFoExit).style('opacity', 0);
    mmFoMerge
      .attr('y', (d) => {
        const hasMulti =
          d.state.depth === 1 &&
          (d.payload?.hasMultiDirectionalLayout ||
            d.payload?.hasBilateralLayout);
        return hasMulti ? this._rootPaddingY / 2 : 0;
      })
      .attr('x', (d) => {
        const hasMulti =
          d.state.depth === 1 &&
          (d.payload?.hasMultiDirectionalLayout ||
            d.payload?.hasBilateralLayout);
        return hasMulti ? paddingX + this._rootPaddingX : paddingX;
      })
      .attr('width', (d) => Math.max(0, d.state.rect.width - paddingX * 2))
      .attr('height', (d) => {
        const hasMulti =
          d.state.depth === 1 &&
          (d.payload?.hasMultiDirectionalLayout ||
            d.payload?.hasBilateralLayout);
        if (hasMulti) {
          return d.state.size?.[1] || d.state.rect.height;
        }
        return d.state.rect.height;
      });
    this.transition(mmFoMerge).style('opacity', 1);

    this.transition(mmPathExit)
      .attrTween('d', function (d) {
        const parentStartRect =
          sourceRectMap[d.source.state.id] || getCollapseParentRect(d.target);
        const anchor = getCollapseAnchor(d.source, d.target, parentStartRect);
        const currentD = this.getAttribute('d') || '';
        const pathStart =
          currentD ||
          buildLinkPath(
            d.source,
            d.target,
            parentStartRect,
            sourceRectMap[d.target.state.id],
          ) ||
          '';
        const pathTarget = linkShape({ source: anchor, target: anchor }) || '';
        const interp = interpolateString(pathStart, pathTarget);
        return (t) => interp(Math.min(1, Math.max(0, t)));
      })
      .attr('stroke-width', 0)
      .remove();

    this.transition(mmPathMerge)
      .attr('stroke', (d) => color(d.target))
      .attr('stroke-width', (d) => lineWidth(d.target))
      .attr('d', (d) => {
        return buildLinkPath(d.source, d.target) || '';
      });

    if (autoFit) this.fit();
  }

  transition<T extends d3.BaseType, U, P extends d3.BaseType, Q>(
    sel: d3.Selection<T, U, P, Q>,
  ): d3.Transition<T, U, P, Q> {
    const { duration } = this.options;
    return sel.transition().duration(duration);
  }

  /**
   * Fit the content to the viewport.
   */
  async fit(maxScale = this.options.maxInitialScale): Promise<void> {
    const svgNode = this.svg.node()!;
    const { width: offsetWidth, height: offsetHeight } =
      svgNode.getBoundingClientRect();
    const { fitRatio } = this.options;
    const { x1, y1, x2, y2 } = this.state.rect;
    const naturalWidth = x2 - x1;
    const naturalHeight = y2 - y1;
    const scale = Math.min(
      (offsetWidth / naturalWidth) * fitRatio,
      (offsetHeight / naturalHeight) * fitRatio,
      maxScale,
    );
    const initialZoom = zoomIdentity
      .translate(
        (offsetWidth - naturalWidth * scale) / 2 - x1 * scale,
        (offsetHeight - naturalHeight * scale) / 2 - y1 * scale,
      )
      .scale(scale);
    return this.transition(this.svg)
      .call(this.zoom.transform, initialZoom)
      .end()
      .catch(noop);
  }

  findElement(node: INode) {
    let result:
      | {
          data: INode;
          g: SVGGElement;
        }
      | undefined;
    this.g
      .selectAll<SVGGElement, INode>(childSelector<SVGGElement>(SELECTOR_NODE))
      .each(function walk(d) {
        if (d === node) {
          result = {
            data: d,
            g: this,
          };
        }
      });
    return result;
  }

  /**
   * Pan the content to make the provided node visible in the viewport.
   */
  async ensureVisible(node: INode, padding?: Partial<IPadding>) {
    const itemData = this.findElement(node)?.data;
    if (!itemData) return;
    const svgNode = this.svg.node()!;
    const relRect = svgNode.getBoundingClientRect();
    const transform = zoomTransform(svgNode);
    const [left, right] = [
      itemData.state.rect.x,
      itemData.state.rect.x + itemData.state.rect.width + 2,
    ].map((x) => x * transform.k + transform.x);
    const [top, bottom] = [
      itemData.state.rect.y,
      itemData.state.rect.y + itemData.state.rect.height,
    ].map((y) => y * transform.k + transform.y);
    // Skip if the node includes or is included in the container.
    const pd: IPadding = {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      ...padding,
    };
    const dxs = [pd.left - left, relRect.width - pd.right - right];
    const dys = [pd.top - top, relRect.height - pd.bottom - bottom];
    const dx = dxs[0] * dxs[1] > 0 ? minBy(dxs, Math.abs) / transform.k : 0;
    const dy = dys[0] * dys[1] > 0 ? minBy(dys, Math.abs) / transform.k : 0;
    if (dx || dy) {
      const newTransform = transform.translate(dx, dy);
      return this.transition(this.svg)
        .call(this.zoom.transform, newTransform)
        .end()
        .catch(noop);
    }
  }

  /** @deprecated Use `ensureVisible` instead */
  ensureView = this.ensureVisible;

  async centerNode(node: INode, padding?: Partial<IPadding>) {
    const itemData = this.findElement(node)?.data;
    if (!itemData) return;
    const svgNode = this.svg.node()!;
    const relRect = svgNode.getBoundingClientRect();
    const transform = zoomTransform(svgNode);
    const x =
      (itemData.state.rect.x + itemData.state.rect.width / 2) * transform.k +
      transform.x;
    const y =
      (itemData.state.rect.y + itemData.state.rect.height / 2) * transform.k +
      transform.y;
    const pd: IPadding = {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      ...padding,
    };
    const cx = (pd.left + relRect.width - pd.right) / 2;
    const cy = (pd.top + relRect.height - pd.bottom) / 2;
    const dx = (cx - x) / transform.k;
    const dy = (cy - y) / transform.k;
    if (dx || dy) {
      const newTransform = transform.translate(dx, dy);
      return this.transition(this.svg)
        .call(this.zoom.transform, newTransform)
        .end()
        .catch(noop);
    }
  }

  /**
   * Scale content with it pinned at the center of the viewport.
   */
  async rescale(scale: number): Promise<void> {
    const svgNode = this.svg.node()!;
    const { width: offsetWidth, height: offsetHeight } =
      svgNode.getBoundingClientRect();
    const halfWidth = offsetWidth / 2;
    const halfHeight = offsetHeight / 2;
    const transform = zoomTransform(svgNode);
    const newTransform = transform
      .translate(
        ((halfWidth - transform.x) * (1 - scale)) / transform.k,
        ((halfHeight - transform.y) * (1 - scale)) / transform.k,
      )
      .scale(scale);
    return this.transition(this.svg)
      .call(this.zoom.transform, newTransform)
      .end()
      .catch(noop);
  }

  destroy() {
    this.svg.on('.zoom', null);
    this.svg.html(null);
    this._disposeList.forEach((fn) => {
      fn();
    });
  }

  static create(
    svg: string | SVGElement | ID3SVGElement,
    opts?: Partial<IMarkmapOptions>,
    data: IPureNode | null = null,
  ): Markmap {
    const mm = new Markmap(svg, opts);
    if (data) {
      mm.setData(data).then(() => {
        mm.fit(); // always fit for the first render
      });
    }
    return mm;
  }
}
