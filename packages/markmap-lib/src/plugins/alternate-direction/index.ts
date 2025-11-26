import { INode, walkTree } from 'markmap-common';
import type { IMarkmapOptions } from 'markmap-view';
import { definePlugin } from '../base';

const name = 'alternateDirection';

function markBilateralRoot(data: INode): void {
  if (!data.children || data.children.length === 0) return;

  let leftCount = 0;
  let rightCount = 0;

  data.children.forEach((child) => {
    if (child.payload?.flip || child.payload?.direction === 'left') {
      leftCount += 1;
    } else {
      rightCount += 1;
    }
  });

  if (leftCount > 0 && rightCount > 0) {
    if (!data.payload?.hasBilateralLayout) {
      data.payload = {
        ...data.payload,
        hasBilateralLayout: true,
        leftChildrenCount: leftCount,
        rightChildrenCount: rightCount,
        leftFolded: data.payload?.leftFolded ?? 0,
        rightFolded: data.payload?.rightFolded ?? 0,
      };
    } else {
      data.payload = {
        ...data.payload,
        leftFolded: data.payload?.leftFolded ?? 0,
        rightFolded: data.payload?.rightFolded ?? 0,
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
      const defaultSide = index % 2 === 1 ? 'left' : 'right';
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

  childrenWithSizes.forEach(({ child, size }) => {
    if (child.payload?.flip || child.payload?.direction === 'left') {
      child.payload = { ...child.payload, direction: 'left' };
      leftSize += size;
      return;
    }
    if (child.payload?.direction === 'right') {
      rightSize += size;
      return;
    }
    if (leftSize <= rightSize) {
      child.payload = { ...child.payload, direction: 'left' };
      leftSize += size;
    } else {
      rightSize += size;
    }
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

            markBilateralRoot(data);

            if (data.payload?.hasBilateralLayout && data.children) {
              data.payload._allChildren = [...data.children];
            }
          } else {
            if (data.payload?._allChildren) {
              data.children = [...(data.payload._allChildren as INode[])];
            }
            if (data.children?.length) {
              markBilateralRoot(data);
            }
          }

          if (data.payload?.hasBilateralLayout && data.children) {
            const filteredChildren = data.children.filter((child: INode) => {
              const isLeft = child.payload?.direction === 'left';
              if (isLeft && data.payload?.leftFolded) return false;
              if (!isLeft && data.payload?.rightFolded) return false;
              return true;
            });
            data.children = filteredChildren;
          }
        },

        afterLayout: (nodes: INode[]) => {
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
        },
      },
    };
  },
});

export default plugin;
