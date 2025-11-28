import { INode, walkTree } from 'markmap-common';
import type { IMarkmapOptions } from 'markmap-view';
import { definePlugin } from '../base';

const name = 'alternateDirection';

function markMultiDirectionalRoot(data: INode): void {
  if (!data.children || data.children.length === 0) return;

  let leftCount = 0;
  let rightCount = 0;
  let topLeftCount = 0;
  let topRightCount = 0;
  let bottomLeftCount = 0;
  let bottomRightCount = 0;

  data.children.forEach((child) => {
    const dir = child.payload?.direction;
    if (dir === 'left' || (child.payload?.flip && !dir)) {
      leftCount += 1;
    } else if (dir === 'right') {
      rightCount += 1;
    } else if (dir === 'top-left') {
      topLeftCount += 1;
    } else if (dir === 'top-right') {
      topRightCount += 1;
    } else if (dir === 'bottom-left') {
      bottomLeftCount += 1;
    } else if (dir === 'bottom-right') {
      bottomRightCount += 1;
    } else {
      rightCount += 1; // default to right
    }
  });

  const directionCounts = [
    leftCount,
    rightCount,
    topLeftCount,
    topRightCount,
    bottomLeftCount,
    bottomRightCount,
  ];
  const hasMultipleDirections = directionCounts.filter((c) => c > 0).length > 1;

  if (hasMultipleDirections) {
    if (!data.payload?.hasMultiDirectionalLayout) {
      data.payload = {
        ...data.payload,
        hasMultiDirectionalLayout: true,
        hasBilateralLayout: leftCount > 0 && rightCount > 0, // for backwards compatibility
        leftChildrenCount: leftCount,
        rightChildrenCount: rightCount,
        topLeftChildrenCount: topLeftCount,
        topRightChildrenCount: topRightCount,
        bottomLeftChildrenCount: bottomLeftCount,
        bottomRightChildrenCount: bottomRightCount,
        leftFolded: data.payload?.leftFolded ?? 0,
        rightFolded: data.payload?.rightFolded ?? 0,
        topLeftFolded: data.payload?.topLeftFolded ?? 0,
        topRightFolded: data.payload?.topRightFolded ?? 0,
        bottomLeftFolded: data.payload?.bottomLeftFolded ?? 0,
        bottomRightFolded: data.payload?.bottomRightFolded ?? 0,
      };
    } else {
      data.payload = {
        ...data.payload,
        leftFolded: data.payload?.leftFolded ?? 0,
        rightFolded: data.payload?.rightFolded ?? 0,
        topLeftFolded: data.payload?.topLeftFolded ?? 0,
        topRightFolded: data.payload?.topRightFolded ?? 0,
        bottomLeftFolded: data.payload?.bottomLeftFolded ?? 0,
        bottomRightFolded: data.payload?.bottomRightFolded ?? 0,
      };
    }
  }
}

function applyAlternateLayout(data: INode): void {
  walkTree(data, (node, next, parent) => {
    const isRootChild = parent === data;
    if (isRootChild) {
      const siblings = parent.children || [];
      const index = siblings.indexOf(node);
      // Cycle through: right, left, top-right, top-left, bottom-right, bottom-left
      const directions = [
        'right',
        'left',
        'top-right',
        'top-left',
        'bottom-right',
        'bottom-left',
      ];
      const defaultSide = directions[index % directions.length];
      const side =
        node.payload?.flip && !node.payload?.direction
          ? defaultSide === 'left'
            ? 'right'
            : 'left'
          : defaultSide;
      node.payload = { ...node.payload, direction: side };
    }
    next();
  });
}

function applyBalancedLayout(data: INode): void {
  const getSubtreeSize = (node: INode): number => {
    if (!node.children || node.children.length === 0) return 1;
    return (
      1 + node.children.reduce((sum, child) => sum + getSubtreeSize(child), 0)
    );
  };

  if (!data.children || data.children.length === 0) return;

  const childrenWithSizes = data.children
    .map((child) => ({
      child,
      size: getSubtreeSize(child),
    }))
    .sort((a, b) => b.size - a.size);

  let leftSize = 0;
  let rightSize = 0;
  let topLeftSize = 0;
  let topRightSize = 0;
  let bottomLeftSize = 0;
  let bottomRightSize = 0;

  childrenWithSizes.forEach(({ child, size }) => {
    const dir = child.payload?.direction;

    // If direction is already set, honor it
    if (dir === 'left' || child.payload?.flip) {
      child.payload = { ...child.payload, direction: 'left' };
      leftSize += size;
      return;
    }
    if (dir === 'right') {
      rightSize += size;
      return;
    }
    if (dir === 'top-left') {
      topLeftSize += size;
      return;
    }
    if (dir === 'top-right') {
      topRightSize += size;
      return;
    }
    if (dir === 'bottom-left') {
      bottomLeftSize += size;
      return;
    }
    if (dir === 'bottom-right') {
      bottomRightSize += size;
      return;
    }

    // Auto-assign to the smallest bucket
    const sizes = [
      { direction: 'left', size: leftSize },
      { direction: 'right', size: rightSize },
      { direction: 'top-left', size: topLeftSize },
      { direction: 'top-right', size: topRightSize },
      { direction: 'bottom-left', size: bottomLeftSize },
      { direction: 'bottom-right', size: bottomRightSize },
    ];
    sizes.sort((a, b) => a.size - b.size);

    const assignedDir = sizes[0].direction;
    child.payload = { ...child.payload, direction: assignedDir };

    // Update the size
    if (assignedDir === 'left') leftSize += size;
    else if (assignedDir === 'right') rightSize += size;
    else if (assignedDir === 'top-left') topLeftSize += size;
    else if (assignedDir === 'top-right') topRightSize += size;
    else if (assignedDir === 'bottom-left') bottomLeftSize += size;
    else if (assignedDir === 'bottom-right') bottomRightSize += size;
  });
}

function processFlipMarkers(
  data: INode,
  layoutStrategy?: 'alternate' | 'balanced',
): void {
  walkTree(data, (node, next, parent) => {
    if (node.payload?.flip) {
      const isRootChild = parent === data || node.state?.depth === 2;

      if (isRootChild) {
        const basePayload = { ...node.payload, flip: true };
        node.payload =
          layoutStrategy === 'alternate'
            ? basePayload
            : { ...basePayload, direction: 'left' };
      }
    }
    next();
  });
}

const plugin = definePlugin({
  name,
  transform() {
    return {
      viewHooks: {
        beforeLayout: (data: INode, options: IMarkmapOptions) => {
          const isFirstRun = !data.payload?._allChildren;

          if (isFirstRun) {
            processFlipMarkers(
              data,
              (options as any).alternateLayout as
                | 'alternate'
                | 'balanced'
                | undefined,
            );

            const layoutStrategy = (options as any).alternateLayout;
            if (layoutStrategy === 'alternate') {
              applyAlternateLayout(data);
            } else if (layoutStrategy === 'balanced') {
              applyBalancedLayout(data);
            }

            markMultiDirectionalRoot(data);

            if (
              (data.payload?.hasBilateralLayout ||
                data.payload?.hasMultiDirectionalLayout) &&
              data.children
            ) {
              data.payload._allChildren = [...data.children];
            }
          } else {
            if (data.payload?._allChildren) {
              data.children = [...(data.payload._allChildren as INode[])];
            }
            if (data.children?.length) {
              markMultiDirectionalRoot(data);
            }
          }

          if (data.payload?.hasMultiDirectionalLayout && data.children) {
            const filteredChildren = data.children.filter((child: INode) => {
              const dir = child.payload?.direction;
              if (dir === 'left' && data.payload?.leftFolded) return false;
              const isRightish = !dir || dir === 'right';
              if (isRightish && data.payload?.rightFolded) return false;
              if (dir === 'top-left' && data.payload?.topLeftFolded)
                return false;
              if (dir === 'top-right' && data.payload?.topRightFolded)
                return false;
              if (dir === 'bottom-left' && data.payload?.bottomLeftFolded)
                return false;
              if (dir === 'bottom-right' && data.payload?.bottomRightFolded)
                return false;
              return true;
            });
            data.children = filteredChildren;
          }
        },

        afterLayout: (nodes: INode[], options: IMarkmapOptions) => {
          // Process horizontal directions (left)
          const leftNodes = nodes.filter(
            (n) => n.payload?.direction === 'left',
          );

          leftNodes.forEach((leftNode) => {
            const hasLeftAncestor = leftNodes.some(
              (maybeParent) =>
                maybeParent !== leftNode &&
                maybeParent.state?.path &&
                leftNode.state?.path?.startsWith(`${maybeParent.state.path}.`),
            );
            if (hasLeftAncestor) return;

            const parentPath = leftNode.state.path
              ?.split('.')
              .slice(0, -1)
              .join('.');
            const parent = nodes.find((n) => n.state.path === parentPath);
            if (!parent) return;

            const subtreeNodes = nodes.filter((n) => {
              return (
                n.state?.path === leftNode.state.path ||
                n.state?.path?.startsWith(leftNode.state.path + '.')
              );
            });

            const parentLeft = parent.state.rect.x;
            const parentRight = parent.state.rect.x + parent.state.rect.width;
            const originalGap = leftNode.state.rect.x - parentRight;
            const targetRight = parentLeft - originalGap;
            const shift =
              targetRight - leftNode.state.rect.width - leftNode.state.rect.x;

            subtreeNodes.forEach((node) => {
              node.state.rect.x += shift;
            });

            const pivot = leftNode.state.rect.x + leftNode.state.rect.width / 2;
            subtreeNodes.forEach((node) => {
              node.state.rect.x =
                2 * pivot - node.state.rect.x - node.state.rect.width;
            });
          });

          // Find the center/root node
          const centerNode = nodes.find((n) => n.state?.depth === 1);
          if (!centerNode) return;

          const centerTop = centerNode.state.rect.y;
          const centerBottom =
            centerNode.state.rect.y + centerNode.state.rect.height;

          // Calculate the maximum vertical extent of left and right branches
          // to avoid collision with top/bottom branches
          // We need to check ALL descendants of left/right branches, not just direct children
          const leftRightRootNodes = nodes.filter(
            (n) =>
              (n.payload?.direction === 'left' ||
                n.payload?.direction === 'right') &&
              n.state?.depth === 2, // Only direct children of root
          );

          let maxTopExtent = 0; // Distance above center
          let maxBottomExtent = 0; // Distance below center
          let maxLeftExtent = 0; // Distance to the left of center
          let maxRightExtent = 0; // Distance to the right of center
          const directionBounds: Record<
            string,
            | {
                minX: number;
                maxX: number;
                minY: number;
                maxY: number;
              }
            | undefined
          > = {};

          if (leftRightRootNodes.length > 0) {
            leftRightRootNodes.forEach((rootNode) => {
              // Find all descendants of this left/right branch
              const branchNodes = nodes.filter((n) => {
                return (
                  n.state?.path === rootNode.state.path ||
                  n.state?.path?.startsWith(rootNode.state.path + '.')
                );
              });

              // Calculate the bounding box of the entire branch relative to center
              branchNodes.forEach((node) => {
                const nodeTop = node.state.rect.y;
                const nodeBottom = node.state.rect.y + node.state.rect.height;
                const nodeLeft = node.state.rect.x;
                const nodeRight = node.state.rect.x + node.state.rect.width;

                // Distance above center (negative Y from center's top)
                if (nodeTop < centerTop) {
                  maxTopExtent = Math.max(maxTopExtent, centerTop - nodeTop);
                }

                // Distance below center (positive Y from center's bottom)
                if (nodeBottom > centerBottom) {
                  maxBottomExtent = Math.max(
                    maxBottomExtent,
                    nodeBottom - centerBottom,
                  );
                }

                // Distance to the left of center
                const centerLeft = centerNode.state.rect.x;
                if (nodeLeft < centerLeft) {
                  maxLeftExtent = Math.max(
                    maxLeftExtent,
                    centerLeft - nodeLeft,
                  );
                }

                // Distance to the right of center
                const centerRight =
                  centerNode.state.rect.x + centerNode.state.rect.width;
                if (nodeRight > centerRight) {
                  maxRightExtent = Math.max(
                    maxRightExtent,
                    nodeRight - centerRight,
                  );
                }

                const dir = node.payload?.direction;
                if (dir) {
                  const current = directionBounds[dir] || {
                    minX: Infinity,
                    maxX: -Infinity,
                    minY: Infinity,
                    maxY: -Infinity,
                  };
                  directionBounds[dir] = {
                    minX: Math.min(current.minX, nodeLeft),
                    maxX: Math.max(current.maxX, nodeRight),
                    minY: Math.min(current.minY, nodeTop),
                    maxY: Math.max(current.maxY, nodeBottom),
                  };
                }
              });
            });
          }

          // Capture bounds for all directions (used to keep vertical branches clear of horizontal ones)
          nodes.forEach((node) => {
            const dir = node.payload?.direction;
            if (!dir) return;
            const nodeLeft = node.state.rect.x;
            const nodeRight = node.state.rect.x + node.state.rect.width;
            const nodeTop = node.state.rect.y;
            const nodeBottom = node.state.rect.y + node.state.rect.height;
            const current = directionBounds[dir] || {
              minX: Infinity,
              maxX: -Infinity,
              minY: Infinity,
              maxY: -Infinity,
            };
            directionBounds[dir] = {
              minX: Math.min(current.minX, nodeLeft),
              maxX: Math.max(current.maxX, nodeRight),
              minY: Math.min(current.minY, nodeTop),
              maxY: Math.max(current.maxY, nodeBottom),
            };
          });

          // Process vertical directions (top-left, top-right, bottom-left, bottom-right)
          const verticalDirections = [
            'top-left',
            'top-right',
            'bottom-left',
            'bottom-right',
          ];

          const verticalGap = Math.max(32, options.spacingVertical * 4.5);
          const horizontalGap = Math.max(24, options.spacingHorizontal * 0.28);
          const baseLineWidth = options.lineWidth(centerNode);
          const stackedBranchGap = Math.max(
            18,
            options.spacingVertical * 1.6,
            baseLineWidth * 2.5,
          );

          verticalDirections.forEach((direction) => {
            const verticalNodes = nodes.filter(
              (n) => n.payload?.direction === direction,
            );

            const rootVerticalNodes = verticalNodes.filter((verticalNode) => {
              const hasVerticalAncestor = verticalNodes.some(
                (maybeParent) =>
                  maybeParent !== verticalNode &&
                  maybeParent.state?.path &&
                  verticalNode.state?.path?.startsWith(
                    `${maybeParent.state.path}.`,
                  ),
              );
              return !hasVerticalAncestor;
            });

            const nodesByParent: Record<string, INode[]> = {};
            rootVerticalNodes.forEach((verticalNode) => {
              const parentPath = verticalNode.state.path
                ?.split('.')
                .slice(0, -1)
                .join('.');
              const key = parentPath || '__root__';
              if (!nodesByParent[key]) nodesByParent[key] = [];
              nodesByParent[key].push(verticalNode);
            });

            Object.entries(nodesByParent).forEach(([parentPath, siblings]) => {
              const parent =
                parentPath === '__root__'
                  ? centerNode
                  : nodes.find((n) => n.state.path === parentPath);
              if (!parent) return;

              const isTop = direction.startsWith('top-');
              const isLeft = direction.endsWith('-left');
              const parentTop = parent.state.rect.y;
              const parentBottom =
                parent.state.rect.y + parent.state.rect.height;
              const centerLeft = parent.state.rect.x;
              const centerRight = parent.state.rect.x + parent.state.rect.width;
              const targetTop = parentBottom + maxBottomExtent + verticalGap;
              const targetBottom = parentTop - maxTopExtent - verticalGap;
              const branchBounds = isLeft
                ? directionBounds.left
                : directionBounds.right;
              const branchEdge = branchBounds
                ? isLeft
                  ? branchBounds.minX
                  : branchBounds.maxX
                : isLeft
                  ? centerLeft
                  : centerRight;
              const directionGap = isLeft
                ? Math.max(horizontalGap * 0.8, maxLeftExtent * 0.08)
                : Math.max(horizontalGap * 0.8, maxRightExtent * 0.08);
              const approachOffset = isLeft
                ? (centerLeft - branchEdge) * 0.45
                : (branchEdge - centerRight) * 0.45;
              const anchorX = isLeft
                ? centerLeft -
                  Math.max(directionGap, approachOffset || horizontalGap)
                : centerRight +
                  Math.max(directionGap, approachOffset || horizontalGap);

              const ordered = [...siblings].sort((a, b) =>
                isTop
                  ? b.state.rect.y - a.state.rect.y
                  : a.state.rect.y - b.state.rect.y,
              );

              let currentBaseline = isTop ? targetBottom : targetTop;
              const lateralFanOut = Math.max(
                options.spacingHorizontal * 0.14,
                horizontalGap * 0.45,
                12,
              );

              ordered.forEach((verticalNode, index) => {
                const subtreeNodes = nodes.filter((n) => {
                  return (
                    n.state?.path === verticalNode.state.path ||
                    n.state?.path?.startsWith(verticalNode.state.path + '.')
                  );
                });

                if (isLeft) {
                  const pivot =
                    verticalNode.state.rect.x +
                    verticalNode.state.rect.width / 2;
                  subtreeNodes.forEach((node) => {
                    node.state.rect.x =
                      2 * pivot - node.state.rect.x - node.state.rect.width;
                  });
                }

                const subtreeBounds = subtreeNodes.reduce(
                  (acc, node) => {
                    const rect = node.state.rect;
                    acc.minX = Math.min(acc.minX, rect.x);
                    acc.maxX = Math.max(acc.maxX, rect.x + rect.width);
                    acc.minY = Math.min(acc.minY, rect.y);
                    acc.maxY = Math.max(acc.maxY, rect.y + rect.height);
                    return acc;
                  },
                  {
                    minX: Infinity,
                    maxX: -Infinity,
                    minY: Infinity,
                    maxY: -Infinity,
                  },
                );

                const shiftY = isTop
                  ? currentBaseline - subtreeBounds.maxY
                  : currentBaseline - subtreeBounds.minY;
                const siblingOffset =
                  (index - (ordered.length - 1) / 2) *
                  (isLeft ? -lateralFanOut : lateralFanOut);
                const shiftX =
                  anchorX +
                  siblingOffset -
                  (isLeft ? subtreeBounds.maxX : subtreeBounds.minX);

                subtreeNodes.forEach((node) => {
                  node.state.rect.x += shiftX;
                  node.state.rect.y += shiftY;
                });

                const newMinY = subtreeBounds.minY + shiftY;
                const newMaxY = subtreeBounds.maxY + shiftY;
                currentBaseline = isTop
                  ? newMinY - stackedBranchGap
                  : newMaxY + stackedBranchGap;
              });
            });
          });
        },
      },
    };
  },
});

export default plugin;
