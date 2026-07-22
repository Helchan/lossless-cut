# Merge Cut Fade-Through-Black Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为多片段合并导出增加默认开启、总时长默认 `0.46s` 的剪切点淡黑过渡，同时保持输出总时长、音频时间线和非边界完整 GOP 的源包复用。

**Architecture:** 用共享常量定义持久化默认值，用纯 `mergeTransition` 规划器把总时长拆成两侧效果并在真实帧吸附后校验短片段；把效果边界交给现有 source-preserving 计划扩展安全 IDR 编码区；仅在边界编码部件上构造 FFmpeg fade 滤镜。`App` 只负责在导出开始时快照设置并选择精确导出路径，工具栏组件只负责编辑设置。

**Tech Stack:** TypeScript 6、React 19、Vitest 4、Testing Library + jsdom、Electron Store、FFmpeg/ffprobe、CSS Modules、i18next、Electron Builder。

## Global Constraints

- 精确输出时长和帧内容优先于源包保留，源包保留优先于速度。
- 不使用 `xfade`，不重叠片段，不插入黑帧，不改变音频增益，不改变 `sum(end - start)`。
- 用户输入的 `0.46s` 是完整剪切点总时长；两侧固定各取 `0.23s`。界面和配置不得自动改写为 `0.466667`。
- FFmpeg fade 的时间参数精度为微秒；共享最小总时长定为 `0.000002s`，保证拆半后的每侧至少 `0.000001s`。常规 UI 步进仍为 `0.01s`。
- 多片段 `merge` 且开关开启时才应用效果；`separate`、关闭开关、单片段合并必须沿用现有行为。
- 短片段在吸附到真实帧 PTS 后、创建 staging 目录或最终输出前拒绝；不得自动缩短效果。
- 有效果的合并继续受现有精确管线约束：一个真实视频轨、H.264、MP4/MOV 家族容器、无外部轨。
- 仅在必要边界窗口及其安全 GOP 依赖区重编码，保留源 B-frame 深度、profile、pix_fmt、timebase 和色彩参数。
- fade-out 的末帧校正使用切点前真实最后一帧 PTS 到半开区间终点的偏移，不使用平均 FPS 猜测，因此 VFR 输入也必须在最后呈现帧到 black。
- `参考/mnrw.mp4` 只作本地人工参考，始终保持未跟踪，不加入任何提交或测试夹具。
- 每一项生产行为都先写失败测试并确认失败原因，再写最小实现并确认转绿。
- 最终只构建 macOS arm64；所有验证通过后才运行仓库规定的 DMG 打包脚本。

---

### Task 1: 建立共享默认值和纯过渡规划器

**Files:**

- Create: `src/common/mergeTransition.ts`
- Create: `src/renderer/src/mergeTransition.ts`
- Create: `src/renderer/src/mergeTransition.test.ts`

- [ ] **Step 1: 先写规划器失败测试**

在 `mergeTransition.test.ts` 覆盖以下输入和精确结果：

```ts
expect(defaultMergeTransitionEnabled).toBe(true);
expect(defaultMergeTransitionDuration).toBe(0.46);
expect(minimumMergeTransitionDuration).toBe(0.000002);

const twoSegmentPlan = buildMergeTransitionPlan({
  intent: 'merge',
  enabled: true,
  totalDuration: 0.46,
  spans: [{ start: 1, end: 4 }, { start: 8, end: 12 }],
});
expect(twoSegmentPlan).toMatchObject({
  applied: true,
  totalDuration: 0.46,
  sideDuration: 0.23,
  expectedDuration: 7,
  joinOutputTimes: [3],
  segments: [
    { fadeInDuration: 0, fadeOutDuration: 0.23, copyStartAtOrAfter: 1, copyEndAtOrBefore: 3.77 },
    { fadeInDuration: 0.23, fadeOutDuration: 0, copyStartAtOrAfter: 8.23, copyEndAtOrBefore: 12 },
  ],
});
```

再添加：三片段中间段同时淡入和淡出；关闭、`separate`、单片段合并返回 `applied: false` 且所有 fade 为 `0`；输入数组顺序不变；输出期望时长等于各段之和；应用效果时 `NaN`、`Infinity`、`0`、`0.000001`、负数总时长报 `invalid-duration`；首段 `< D`、末段 `< D`、中间段 `< T` 分别报 `segment-too-short`，并断言 `segmentIndex`、`actualDuration`、`requiredDuration`；长度恰好等于要求时通过。

- [ ] **Step 2: 运行红测并记录缺失模块失败**

Run:

```bash
yarn test run src/renderer/src/mergeTransition.test.ts
```

Expected: FAIL，错误只来自 `mergeTransition` 模块或导出尚不存在，而不是测试语法错误。

- [ ] **Step 3: 实现共享默认值和合法值解析**

`src/common/mergeTransition.ts` 固定导出：

```ts
export const defaultMergeTransitionEnabled = true;
export const defaultMergeTransitionDuration = 0.46;
export const minimumMergeTransitionDuration = 0.000002;

export function parseMergeTransitionDuration(value: string | number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimumMergeTransitionDuration ? parsed : undefined;
}
```

解析器不做钳制、不做两位小数改写，合法数值原样返回，并拒绝带尾随字符的字符串。规划器测试同时断言 `parseMergeTransitionDuration('0.72') === 0.72`，而空字符串、`'0.72x'`、小于 `0.000002`、负数和非有限值都返回 `undefined`。

- [ ] **Step 4: 实现纯规划器的稳定接口**

`src/renderer/src/mergeTransition.ts` 以显式 `../../common/mergeTransition.ts` specifier 导入运行时最小值常量，保证 `script/testExactExport.ts` 经 Node strip-types 直接加载时不会出现 `ERR_MODULE_NOT_FOUND`，并导出以下类型和函数：

```ts
export interface MergeTransitionSpan { start: number; end: number }

export interface MergeTransitionSegmentPlan extends MergeTransitionSpan {
  fadeInDuration: number;
  fadeOutDuration: number;
  copyStartAtOrAfter: number;
  copyEndAtOrBefore: number;
}

export interface MergeTransitionPlan {
  applied: boolean;
  totalDuration: number;
  sideDuration: number;
  expectedDuration: number;
  segments: MergeTransitionSegmentPlan[];
  joinOutputTimes: number[];
}

export type MergeTransitionPlanErrorCode =
  | 'invalid-duration'
  | 'invalid-segment'
  | 'segment-too-short';

export class MergeTransitionPlanError extends Error {
  readonly code: MergeTransitionPlanErrorCode;
  readonly segmentIndex?: number;
  readonly actualDuration?: number;
  readonly requiredDuration?: number;
}

export function isMergeTransitionApplicable(input: {
  intent: SegmentExportIntent;
  enabled: boolean;
  segmentCount: number;
}): boolean;

export function buildMergeTransitionPlan(input: {
  intent: SegmentExportIntent;
  enabled: boolean;
  totalDuration: number;
  spans: readonly MergeTransitionSpan[];
}): MergeTransitionPlan;
```

实现规则：先验证所有 span 都满足有限的 `0 <= start < end`；`isMergeTransitionApplicable` 只在 `merge && enabled === true && segmentCount >= 2` 时为真；未应用时 `totalDuration` 和 `sideDuration` 返回 `0`；应用时先要求 `T >= minimumMergeTransitionDuration`，再令 `D = T / 2`，首段只淡出、末段只淡入、中间段两侧都有；以 `1e-9` 数值容差校验最短时长，避免一微秒级合法下限被 GOP 边界容差吞掉；`copyStartAtOrAfter = start + fadeInDuration`、`copyEndAtOrBefore = end - fadeOutDuration`；`joinOutputTimes` 是前面片段时长的累加值。

- [ ] **Step 5: 运行绿测**

Run:

```bash
yarn test run src/renderer/src/mergeTransition.test.ts
```

Expected: PASS，默认值、适用条件、两/三片段、短片段和总时长测试全部通过。

- [ ] **Step 6: 提交规划层**

```bash
git add src/common/mergeTransition.ts src/renderer/src/mergeTransition.ts src/renderer/src/mergeTransition.test.ts
git commit -m "feat: plan merge cut fade transitions"
```

---

### Task 2: 扩展 source-preserving 部件计划和 FFmpeg 滤镜构造

**Files:**

- Modify: `src/renderer/src/sourcePreservingExport.ts`
- Modify: `src/renderer/src/sourcePreservingExport.test.ts`
- Modify: `src/renderer/src/hooks/useFfmpegOperations.ts`（本任务只做参数名和纯滤镜调用的编译接线）
- Modify: `script/testExactExport.ts`（本任务只做参数名兼容）

- [ ] **Step 1: 先为效果边界写失败单测**

在 `sourcePreservingExport.test.ts` 增加：

```ts
expect(buildSourcePreservingSegmentPlan({
  span: { start: 0, end: 10 },
  fadeInDuration: 0.23,
  fadeOutDuration: 0.23,
  nextSafeIdrAtOrAfterCopyStart: 2,
  previousSafeIdrAtOrBeforeCopyEnd: 8,
  sourceDuration: 10,
}).parts).toEqual([
  { mode: 'encode', start: 0, end: 2, fadeInDuration: 0.23 },
  { mode: 'copy', start: 2, end: 8 },
  { mode: 'encode', start: 8, end: 10, fadeOutDuration: 0.23 },
]);
```

并覆盖：

- `fadeInDuration + fadeOutDuration` 等于整段时，生成一个同时携带两种效果的 encode part；
- IDR 复制起点早于 `start + fadeInDuration` 或复制终点晚于 `end - fadeOutDuration` 时抛错；
- 源起点只有无淡入时可直接当作 copy-safe，源终点只有无淡出时可直接当作 copy-safe；
- copy part 永远没有 fade 字段；无效果计划对象形状与当前测试完全一致；
- fade 时长必须有限且非负，和不得超过片段时长。

再为纯滤镜函数写精确字符串测试：

```ts
expect(buildSourcePreservingVideoFilter({ duration: 2 })).toBe(
  'setpts=PTS-STARTPTS,trim=duration=2.000000,setpts=PTS-STARTPTS',
);

expect(buildSourcePreservingVideoFilter({
  duration: 2,
  lastFrameOffset: 1 / 60,
  fadeInDuration: 0.23,
  fadeOutDuration: 0.23,
})).toBe(
  'setpts=PTS-STARTPTS,trim=duration=2.000000,setpts=PTS-STARTPTS,'
  + 'fade=t=in:st=0:d=0.230000:c=black,'
  + 'fade=t=out:st=1.753333:d=0.230000:c=black',
);
```

断言有 fade-out 但缺少、为零、大于部件时长或非有限 `lastFrameOffset` 时抛错；无 fade-out 时不要求 `lastFrameOffset`。用 `duration=2,lastFrameOffset=0.04,D=0.23` 断言 VFR 风格 offset 得到 `st=1.730000`。再为仅含一个呈现帧的部件分别覆盖 fade-out-only、fade-in-only、两者并存，确保生成的滤镜不会包含 `d=0.000000`。

- [ ] **Step 2: 运行红测**

Run:

```bash
yarn test run src/renderer/src/sourcePreservingExport.test.ts
```

Expected: FAIL，失败集中在新类型、复制目标和滤镜函数尚未实现；原有时长/验证测试仍通过。

- [ ] **Step 3: 实现效果感知的部件联合类型**

在 `sourcePreservingExport.ts` 使用：

```ts
export interface SourcePreservingFadeDurations {
  fadeInDuration?: number | undefined;
  fadeOutDuration?: number | undefined;
}

export type SourcePreservingPart =
  | (SourcePreservingSpan & { mode: 'copy' })
  | (SourcePreservingSpan & {
      mode: 'encode';
      fadeInDuration?: number | undefined;
      fadeOutDuration?: number | undefined;
    });
```

新增 `getSourcePreservingCopyTargets`，返回 `span.start + fadeInDuration` 和 `span.end - fadeOutDuration`。效果时长合法性使用独立 `1e-9` 数值容差，不复用现有 `1e-6` GOP 拼接容差。将 builder 参数重命名为 `nextSafeIdrAtOrAfterCopyStart`、`previousSafeIdrAtOrBeforeCopyEnd`，同步修改现有单测、hook 和精确导出脚本的调用名。前缀 encode 只携带 fade-in，后缀 encode 只携带 fade-out；前后编码区相触或重叠时生成一个同时携带两者的 encode part；条件展开必须保证无效果对象没有值为 `undefined` 的额外字段。

- [ ] **Step 4: 实现末帧到黑的纯滤镜构造器**

`buildSourcePreservingVideoFilter` 保持自包含，不新增运行时相对 import；这样 `script/testExactExport.ts` 可继续由 Node strip-types 直接加载。它先生成当前完全相同的 `setpts,trim,setpts` 基础字符串。fade-in 使用 `st=0,d=D`。fade-out 接收切点前最后一个真实呈现帧到部件半开终点的 `lastFrameOffset`，正常起点为：

```ts
const idealFadeOutStart = duration - fadeOutDuration - lastFrameOffset;
const fadeOutStart = Math.max(idealFadeOutStart, 0);
const effectiveFadeOutDuration = idealFadeOutStart >= 0
  ? fadeOutDuration
  : duration - lastFrameOffset;
```

正常边界部件用 `duration - D - lastFrameOffset`，使真实最后一帧 PTS 代入 fade 后进度正好为 `1`。只有当编码部件短到无法提前该偏移开始时才把起点钳为 `0` 并把 fade filter 的采样时长缩短到可用帧间隔。若 `duration - lastFrameOffset <= 1e-6`，表示部件只有一个呈现帧；fade-out 精确追加 `fade=t=in:st=<duration>:d=<fadeOutDuration>:c=black`，利用该唯一帧位于 `st` 之前的语义把它采样为 black。fade-in-only 仍用正常 fade-in；两者并存时依次追加正常 fade-in 和这个单帧 black filter。对应单测使用 `duration=1/60`、`lastFrameOffset=1/60`、`fade duration=0.01` 锁定三种精确字符串，并在 Task 4 用真实 FFmpeg 解码亮度。所有基础 trim 秒值仍用当前六位格式；共享最小总时长保证 fade 的 `d` 不会格式化为零。

- [ ] **Step 5: 在 `cutEncodeSmartPart` 使用结构化效果参数**

签名加入：

```ts
fadeInDuration?: number | undefined;
fadeOutDuration?: number | undefined;
lastFrameOffset?: number | undefined;
```

以上 optional 字段在类型中写为 `?: number | undefined`，兼容仓库的 `exactOptionalPropertyTypes`。若存在任何 fade 而 `forceClosedGop !== true`，立即抛出内部错误。闭合 GOP 分支调用 `buildSourcePreservingVideoFilter`，替换当前硬编码基础滤镜；无效果时生成的 FFmpeg 参数必须逐字符保持现状。profile、pix_fmt、色彩参数、timebase 和 `getSourcePreservingBoundaryBFrames` 路径不动。

- [ ] **Step 6: 运行定向绿测和类型检查**

Run:

```bash
yarn test run src/renderer/src/sourcePreservingExport.test.ts
yarn tsc
```

Expected: 两条命令 PASS；旧 source-preserving 测试和新效果测试同时通过。

- [ ] **Step 7: 提交 source-preserving 扩展**

```bash
git add src/renderer/src/sourcePreservingExport.ts src/renderer/src/sourcePreservingExport.test.ts src/renderer/src/hooks/useFfmpegOperations.ts script/testExactExport.ts
git commit -m "feat: add fade filters to precise boundary encoding"
```

---

### Task 3: 在导出入口快照设置并强制选择精确路径

**Files:**

- Modify: `src/common/types.ts`
- Modify: `src/main/configStore.ts`
- Modify: `src/renderer/src/hooks/useUserSettingsRoot.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/hooks/useFfmpegOperations.ts`
- Modify: `src/renderer/src/mergeTransition.test.ts`
- Create: `src/renderer/src/mergeTransitionExport.ts`
- Create: `src/renderer/src/mergeTransitionExport.test.ts`

- [ ] **Step 1: 先写导出决策和 IDR 搜索规划红测**

在 `mergeTransition.test.ts` 加矩阵，明确 `merge/true/2` 为 `true`，而 `merge/false/2`、`merge/true/1`、`separate/true/2` 都为 `false`；再断言非法 `segmentCount` 不会被误判为适用。

新建 `mergeTransitionExport.test.ts`，先导入尚不存在的纯函数并覆盖：

```ts
resolveMergeTransitionExportDecision({
  intent: 'merge',
  snapshot: { enabled: true, totalDuration: 0.46 },
  segmentCount: 2,
  accurateCut: false,
  areWeCutting: false,
})
```

返回 `transitionApplies: true`、`shouldUseAccurateCut: true`；off、separate、single 不因效果强制精确路径；原有 accurate/cutting 仍可独立强制精确路径。`buildSnappedMergeTransitionPreflight` 对已经吸附的 spans 生成计划，并对短首/末/中段同步抛出带结构化字段的 `MergeTransitionPlanError`。`buildTransitionIdrSearchPlan` 对首/中/末段返回绝对 `searchStart/searchEnd` 和 copy target；复制目标相触时返回 `fullyEncode: true` 且没有搜索请求。`getLastFrameOffset` 用不等间隔相对 PTS（例如 segment end `10`、最后两帧 `9.91/9.96`）返回真实 `0.04`，并拒绝空数组、越界帧和非正 offset。再加 `sourceStartTime=5, segment={start:0,end:10}, windowDuration=2` 用例：`buildLastFrameReadWindow` 返回绝对 `[13,15)`，`normalizeFramePts([14.91,14.96], 5)` 返回 `[9.91,9.96]`，最终 offset 仍为 `0.04`。这样 App 决策、吸附后校验、VFR/非零容器起点的末帧计算和 hook 的 IDR 请求都有可直接执行的先红测试。

Run:

```bash
yarn test run src/renderer/src/mergeTransition.test.ts src/renderer/src/mergeTransitionExport.test.ts
```

Expected: FAIL，非法计数用例和缺失的导出规划模块均明确失败。

- [ ] **Step 2: 实现纯导出规划模块并转绿**

要求 `segmentCount` 是非负安全整数，再执行三条件判断。`mergeTransitionExport.ts` 导出：

```ts
export interface MergeTransitionSnapshot {
  enabled: boolean;
  totalDuration: number;
}

export function resolveMergeTransitionExportDecision(input: {
  intent: SegmentExportIntent;
  snapshot: MergeTransitionSnapshot;
  segmentCount: number;
  accurateCut: boolean;
  areWeCutting: boolean;
}): { transitionApplies: boolean; shouldUseAccurateCut: boolean };

export function buildSnappedMergeTransitionPreflight(input: {
  intent: SegmentExportIntent;
  snapshot: MergeTransitionSnapshot;
  spans: readonly MergeTransitionSpan[];
}): MergeTransitionPlan;

export function buildTransitionIdrSearchPlan(input: {
  segment: MergeTransitionSegmentPlan;
  sourceStartTime: number;
}): {
  fullyEncode: boolean;
  after?: { time: number; searchStart: number; searchEnd: number };
  before?: { time: number; searchStart: number; searchEnd: number };
};

export function getLastFrameOffset(input: {
  segment: MergeTransitionSpan;
  framePts: readonly number[];
}): number;

export function buildLastFrameReadWindow(input: {
  segment: MergeTransitionSpan;
  sourceStartTime: number;
  windowDuration: number;
}): { from: number; to: number };

export function normalizeFramePts(input: {
  absoluteFramePts: readonly number[];
  sourceStartTime: number;
}): number[];
```

本模块只组合 Task 1 的纯规划器，不读 React context、不运行 FFmpeg。所有到 `segmentExportPlan` 的依赖使用 `import type`，不形成 Node 运行时依赖。

Run:

```bash
yarn test run src/renderer/src/mergeTransition.test.ts src/renderer/src/mergeTransitionExport.test.ts
```

Expected: PASS。

- [ ] **Step 3: 增加 Config 默认值和持久化链路**

在 `Config` 增加：

```ts
mergeTransitionEnabled: boolean;
mergeTransitionDuration: number;
```

`configStore` 以主进程现有约定的 `../common/mergeTransition.js` specifier 导入共享常量，并把 defaults 设为 `true` 和 `0.46`。`useUserSettingsRoot` 在 `autoMerge` 附近加入两组 state/effect，并把值放进 `settings`、setter 放进返回对象。旧配置依靠 electron-store defaults 自动获得字段，不增加破坏性迁移，不改 `contexts.ts` 的推导类型。

- [ ] **Step 4: 在 `App.executeExport` 创建不可变设置快照**

从 `allUserSettings.settings` 解构 `mergeTransitionEnabled`、`mergeTransitionDuration`。在算出 `effectiveWillMerge` 后立即构造：

```ts
const mergeTransitionSnapshot = {
  enabled: mergeTransitionEnabled,
  totalDuration: mergeTransitionDuration,
};
const { transitionApplies, shouldUseAccurateCut } = resolveMergeTransitionExportDecision({
  intent: effectiveWillMerge ? 'merge' : 'separate',
  snapshot: mergeTransitionSnapshot,
  segmentCount: effectiveSegmentsToExport.length,
  accurateCut: effectiveExportOptions.accurateCut === true,
  areWeCutting: effectiveAreWeCutting,
});
```

把快照传给 `exportSourcePreservingSegments`。在 `executeExport` 依赖数组加入两个设置值。不得在异步导出中再次读取 context，确保导出过程中编辑控件只影响下一次导出。若 `shouldUseAccurateCut` 但 `detectedFileFormat == null`，在原 `invariant` 位置改抛本地化 `UserFacingError`：`transitionApplies` 时使用效果专属容器错误；原有 separate/accurate/cutting 路径使用通用 precise-export 容器错误，不能误报为淡黑效果失败。

- [ ] **Step 5: 在真实帧吸附后、staging 前生成过渡计划**

`exportSourcePreservingSegments` 参数增加：

```ts
mergeTransition: {
  enabled: boolean;
  totalDuration: number;
};
```

在 `exactSegments` 完成后立刻调用已红绿验证的 `buildSnappedMergeTransitionPreflight`。捕获 `MergeTransitionPlanError`：

- `invalid-duration` 转为含 `minimumDuration = 0.000002` 的 `UserFacingError(i18n.t('Fade-through-black transition duration must be a finite number of at least {{minimumDuration}}s.', ...))`；
- `segment-too-short` 转为含 `segmentNumber = index + 1`、实际值和所需值的本地化错误；两种秒值用最多六位小数并去掉尾随零，保证默认 `0.23` 简洁且微秒下限不会显示成 `0.000`；
- 其他规划错误继续抛出，不创建 staging。

代码顺序必须保持 `exactSegments -> buildSnappedMergeTransitionPreflight -> final path checks -> mkdtemp`；对应单测验证同步 preflight 会抛错，代码复核确认 `mkdtemp` 位于调用之后。

- [ ] **Step 6: 按效果复制目标搜索片段内安全 IDR**

用已测试的 `buildTransitionIdrSearchPlan` 生成目标，再扩展 `findSafeRandomAccessPoint` 参数为：

```ts
{
  time: number;
  mode: 'before' | 'after';
  searchStart: number;
  searchEnd: number;
}
```

所有搜索窗口和候选必须同时落入当前片段绝对范围 `[searchStart, searchEnd]`。对每段先读取对应的 `MergeTransitionSegmentPlan`：

- 复制目标相触或交叠时跳过两次 IDR 搜索并整段 encode；
- 否则从 `copyStartAtOrAfter` 向后找首个安全 IDR，从 `copyEndAtOrBefore` 向前找末个安全 IDR；
- 只有 `fadeInDuration === 0` 且在源开头时才可直接把源开头视为安全；
- 只有 `fadeOutDuration === 0` 且在源结尾时才可直接把源结尾视为安全。

把两侧 fade 时长和安全 IDR 传给 `buildSourcePreservingSegmentPlan`。

对每个有 fade-out 的 segment，在创建 staging 前读取切点前最后一个真实呈现帧 PTS。segment 和 transition plan 使用相对容器起点的坐标；hook 必须调用已红绿验证的 `buildLastFrameReadWindow` 生成绝对 `[sourceStartTime + max(start, end - window), sourceStartTime + end)`，再用 `normalizeFramePts` 把每个 `frame.time` 减去 `sourceStartTime` 后传给 `getLastFrameOffset`。先查末尾 2 秒；若没有帧，以 `2, 8, 32...` 秒指数扩展但不越过 segment start。纯函数取最大 `relativeFramePts < end - 1e-9`，计算 `lastFrameOffset = end - relativeFramePts`，并要求有限且 `0 < lastFrameOffset <= segment duration`。找不到时抛本地化 `UserFacingError('Fade-through-black transition requires reliable source frame timing.')`。这一步按真实 PTS 工作，不用 `1 / detectedFps`，可覆盖 VFR 和非零 source start time。

- [ ] **Step 7: 只给 encode part 传效果和真实末帧偏移**

调用 `cutEncodeSmartPart` 时增加：

```ts
...(part.fadeInDuration != null ? { fadeInDuration: part.fadeInDuration } : {}),
...(part.fadeOutDuration != null ? {
  fadeOutDuration: part.fadeOutDuration,
  lastFrameOffset: segmentLastFrameOffsets[segmentIndex],
} : {}),
```

使用条件展开而不是显式传 `undefined`，满足 `exactOptionalPropertyTypes`；fade-out 存在时先 invariant 对应真实 offset 已解析。copy 分支不接受也不读取效果。音频仍只调用现有 `encodeSourceAudioSpans({ spans: exactSegments })`。合并 `expectedDuration` 仍是 `sum(segmentDurations)`。将过渡 join 位置加入 `mergedVerificationTimes`，保证每个切点前后都执行 `ffmpeg -xerror` 解码窗口验证。

- [ ] **Step 8: 运行定向和静态验证**

Run:

```bash
yarn test run src/renderer/src/mergeTransition.test.ts src/renderer/src/mergeTransitionExport.test.ts src/renderer/src/sourcePreservingExport.test.ts
yarn tsc
yarn eslint --ext .ts,.tsx src/common/types.ts src/main/configStore.ts src/renderer/src/hooks/useUserSettingsRoot.ts src/renderer/src/App.tsx src/renderer/src/hooks/useFfmpegOperations.ts src/renderer/src/mergeTransition.ts src/renderer/src/mergeTransitionExport.ts src/renderer/src/sourcePreservingExport.ts
```

Expected: 全部 PASS；lint 不得通过禁用规则规避依赖数组或类型问题。

- [ ] **Step 9: 提交导出接线**

```bash
git add src/common/types.ts src/main/configStore.ts src/renderer/src/hooks/useUserSettingsRoot.ts src/renderer/src/App.tsx src/renderer/src/hooks/useFfmpegOperations.ts src/renderer/src/mergeTransition.test.ts src/renderer/src/mergeTransitionExport.ts src/renderer/src/mergeTransitionExport.test.ts
git commit -m "feat: apply fade transitions during merged export"
```

---

### Task 4: 增加可重复的 60 fps 真实 FFmpeg 回归

**Files:**

- Modify: `script/testExactExport.ts`

- [ ] **Step 1: 增加独立的过渡测试素材和先失败断言**

只在没有 `LOSSLESSCUT_REAL_SOURCE` 时生成第二份素材：`320x180`、60 fps、8 秒、恒定中灰视频，H.264 High、`yuv420p`、GOP 60、`-bf 2`、AAC 48 kHz。使用片段 `[0.1, 3.1)` 和 `[4.9, 7.6)`，总时长 `5.7s`，总帧数 `342`，切点输出帧索引 `180`。

先让过渡分支导出与 control 相同的无 fade 视频，再加入以下亮度断言：上一段末帧和下一段首帧都接近合法 black、淡出单调下降、淡入单调上升、两侧受影响帧数在 `13..15`。用现有命令运行并确认亮度断言 FAIL，证明测试能抓到缺失效果。

Run:

```bash
yarn test-exact-export
```

Expected: FAIL，错误来自切点亮度未到 black，不得来自主 30 fps 回归。

- [ ] **Step 2: 让脚本复用生产规划器和生产滤镜**

使用显式 `.ts` specifier 导入 `buildMergeTransitionPlan`、`getSourcePreservingCopyTargets`、`buildSourcePreservingVideoFilter`，保证 Node strip-types ESM 可解析。`exportPart` 增加 `lastFrameOffset`，encode 分支的 `-vf` 必须直接使用生产滤镜函数。对 faded 输出使用过渡规划器的复制目标选择安全 IDR，并从测试源真实 packet/frame PTS 计算每段末帧 offset；control 输出使用相同 spans、相同编码参数但 fade 为零。不得在脚本复制一份 fade 字符串。

- [ ] **Step 3: 完成视频、源包和音频断言**

新增小工具把 faded/control 解码为 `1x1 gray` 原始帧亮度数组，并断言：

- faded/control 总时长均为 `5.7s`，容差不超过 `1/60s`；
- 两者均为 `342` 帧且 packet presentation coverage 相同；
- `luma[179]` 和 `luma[180]` 都在合法 black 阈值内，分别锁定上一段末帧和下一段首帧；
- 淡出/淡入各 `13..15` 个变化帧，趋势允许每帧最多 3 个亮度级的编码噪声；
- 效果区外亮度恢复到 control 的容差 3；
- `[1,2)`、`[6,7)` 两段 planned copy packets 的逐包 hash 保留率各至少 `98%`；
- 输出 `has_b_frames === 2`，profile、pix_fmt、time_base 与源一致；
- faded 和 control 在切点窗口执行 `ffmpeg -xerror` 均成功；
- 两个最终文件复用同一份已编码 audio artifact，音频 packet 的 PTS、duration、hash 数组完全相同。

另生成一帧白色视频 smoke fixture，分别调用生产滤镜的 fade-out-only、fade-in-only、两者并存分支并解码 `1x1 gray`；三种输出的唯一帧都必须在 black 阈值内，直接验证 Task 2 的单帧特殊分支。

- [ ] **Step 4: 运行绿测两次确认确定性**

Run:

```bash
yarn test-exact-export
yarn test-exact-export
```

Expected: 两次 PASS；摘要打印 transition 总时长、切点帧、两侧变化帧数、两段复制包保留率和音频包一致性。

- [ ] **Step 5: 提交真实回归**

```bash
git add script/testExactExport.ts
git commit -m "test: verify frame-exact merged fade transitions"
```

---

### Task 5: 持久化设置并实现固定工具栏组件

**Files:**

- Create: `src/renderer/src/components/MergeTransitionControl.tsx`
- Create: `src/renderer/src/components/MergeTransitionControl.module.css`
- Create: `src/renderer/src/components/MergeTransitionControl.dom.test.tsx`
- Modify: `src/renderer/src/BottomBar.tsx`
- Modify: `package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: 安装 DOM 测试依赖**

Run:

```bash
yarn add -D @testing-library/react jsdom
```

Expected: `package.json` 和 `yarn.lock` 只增加所需测试依赖及其解析依赖，安装成功。

- [ ] **Step 2: 先写组件失败测试**

测试文件首行使用：

```ts
// @vitest-environment jsdom
```

mock `react-i18next` 令 `t(key) => key`，导入测试用受控组件 `MergeTransitionControlView`。用本地 Harness 持有 enabled/duration，覆盖：默认 checkbox 的 `aria-checked` 为 true 且 number input 值为 `0.46`；取消勾选后 spinbutton 和单位 `s` 都消失；再次勾选恢复 `0.46`；输入 `0.72` 后 blur 提交；编辑期间允许空字符串；空值、低于 `0.000002`、负数、`Infinity` 和带尾随字符的字符串在 blur/Enter 时恢复最近合法值；合法值按 Enter 提交；`step="0.01"`、省略 `min`、duration 的可访问名称存在，并断言默认输入的 `validity.stepMismatch === false`。技术下限只由共享 parser 执行，避免 HTML 的 min 成为 step base 后让默认 `0.46` 落入错误网格。

Run:

```bash
yarn test run src/renderer/src/components/MergeTransitionControl.dom.test.tsx
```

Expected: FAIL，因为组件尚不存在。

- [ ] **Step 3: 实现受控 View 和 context connector**

`MergeTransitionControl.tsx` 导出：

```ts
export interface MergeTransitionControlViewProps {
  enabled: boolean;
  duration: number;
  onEnabledChange: (enabled: boolean) => void;
  onDurationChange: (duration: number) => void;
}

export function MergeTransitionControlView(props: MergeTransitionControlViewProps): ReactElement;
export default function MergeTransitionControl(): ReactElement;
```

default connector 从 `useUserSettings` 读取两值和两个 setter。View 用现有 `Checkbox`，标签 key 固定为 `Fade through black at cut points`。本地 `draft` state 用字符串保存编辑态，并在外部合法 duration 改变时同步。`onBlur` 和 Enter 共用 commit：`parseMergeTransitionDuration` 返回值时调用 setter 并把 draft 格式化为普通十进制；无效时恢复当前合法 duration。Radix `onCheckedChange` 仅把 `checked === true` 传出。关闭开关不修改 duration。

- [ ] **Step 4: 固定插入用户截图标注位置**

在 `BottomBarFirstRow` 左侧容器给现有 style 增加 `overflow: 'hidden'`，并严格在 `{leadingControls}` 后、`{hasAudio && (...)}` 前插入：

```tsx
{leadingControls}
<MergeTransitionControl />
```

组件不读取 `effectiveExportMode`，不随合并/单独模式显隐。CSS Module 使用单行 flex、`min-width: 0`、固定 `3.4em` 数值框、`flex: 0 1 auto` 标签区域和 `flex: 0 0 auto` 输入区域；文字空间不足时省略，不覆盖中央播放/时间控件或相邻按钮。

- [ ] **Step 5: 运行组件、配置和静态验证**

Run:

```bash
yarn test run src/renderer/src/components/MergeTransitionControl.dom.test.tsx src/renderer/src/mergeTransition.test.ts
yarn tsc
yarn eslint --ext .ts,.tsx src/renderer/src/components/MergeTransitionControl.tsx src/renderer/src/BottomBar.tsx
```

Expected: 全部 PASS；组件在 disabled 状态下不渲染 duration group，重新开启保留最后合法值。

- [ ] **Step 6: 提交设置和组件**

```bash
git add package.json yarn.lock src/renderer/src/components/MergeTransitionControl.tsx src/renderer/src/components/MergeTransitionControl.module.css src/renderer/src/components/MergeTransitionControl.dom.test.tsx src/renderer/src/BottomBar.tsx
git commit -m "feat: add merge transition toolbar control"
```

---

### Task 6: 增加本地化文案和用户文档

**Files:**

- Modify: `locales/en/translation.json`
- Modify: `locales/zh_Hans/translation.json`
- Modify: `locales/zh_Hant/translation.json`
- Modify: `README.md`
- Modify: `docs/index.md`
- Modify: `docs/troubleshooting.md`

- [ ] **Step 1: 扫描生产代码中的新英文 key**

Run:

```bash
yarn scan-i18n
```

Expected: 英文翻译文件出现以下 key，且现有 key 没有意外丢失：

```text
Fade through black at cut points
Transition duration
Fade-through-black transition duration must be a finite number of at least {{minimumDuration}}s.
Fade-through-black transition requires reliable source frame timing.
Unable to determine the source container required for precise fade-through-black export.
Unable to determine the source container required for precise export.
Segment {{segmentNumber}} is {{actualDuration}}s long, but the fade-through-black transition requires at least {{requiredDuration}}s.
```

- [ ] **Step 2: 添加简体和繁体中文翻译**

使用以下确定文案：

| English key | zh_Hans | zh_Hant |
|---|---|---|
| Fade through black at cut points | 剪切点淡黑过渡 | 剪切點淡黑過渡 |
| Transition duration | 过渡总时长 | 過渡總時長 |
| Fade-through-black transition duration must be a finite number of at least {{minimumDuration}}s. | 淡黑过渡总时长必须是至少 {{minimumDuration}}s 的有限数值。 | 淡黑過渡總時長必須是至少 {{minimumDuration}}s 的有限數值。 |
| Fade-through-black transition requires reliable source frame timing. | 淡黑过渡需要可靠的源视频帧时间信息。 | 淡黑過渡需要可靠的來源視訊影格時間資訊。 |
| Unable to determine the source container required for precise fade-through-black export. | 无法识别精确淡黑过渡导出所需的源容器。 | 無法識別精準淡黑過渡匯出所需的來源容器。 |
| Unable to determine the source container required for precise export. | 无法识别精确导出所需的源容器。 | 無法識別精準匯出所需的來源容器。 |
| Segment {{segmentNumber}} is {{actualDuration}}s long, but the fade-through-black transition requires at least {{requiredDuration}}s. | 第 {{segmentNumber}} 个片段时长为 {{actualDuration}}s，淡黑过渡至少需要 {{requiredDuration}}s。 | 第 {{segmentNumber}} 個片段時長為 {{actualDuration}}s，淡黑過渡至少需要 {{requiredDuration}}s。 |

- [ ] **Step 3: 更新功能、工作流和限制说明**

`README.md` Features 增加“merged cut points can fade through black with configurable duration”；第 131 行“actual cut/export ... lossless”后明确例外：启用淡黑过渡会重编码效果窗口和安全 GOP 依赖区，其余完整 GOP 仍复制。

`docs/index.md`：

- 从“fade/transition 一律不支持”的 FAQ 列表移除视频 fade/transition，并补充只支持同一源 H.264 MP4/MOV 多片段 merge 的淡黑形式；
- Typical workflow 在 `Merge cuts` 后说明工具栏复选框、默认 `0.46s`、数值为完整的暗下去再亮起来总时长；
- 说明不改变音频和合并总时长。

`docs/troubleshooting.md` 的 merge 章节增加：总时长至少 `0.000002s`；短片段规则（首/末至少 `T/2`、中间至少 `T`）；支持边界；缺失可靠边界帧 PTS 时的明确拒绝；关闭复选框恢复原行为。

- [ ] **Step 4: 验证翻译与文档格式**

Run:

```bash
yarn scan-i18n
git diff --check
```

Expected: scan 不再改动文件；无缺失 key、尾随空格或 Markdown 空白错误。

- [ ] **Step 5: 提交本地化和文档**

```bash
git add locales/en/translation.json locales/zh_Hans/translation.json locales/zh_Hant/translation.json README.md docs/index.md docs/troubleshooting.md
git commit -m "docs: explain merged fade transitions"
```

---

### Task 7: 递增小版本并生成发布说明

**Files:**

- Modify: `package.json`
- Modify: `no.mifi.losslesscut.appdata.xml`
- Create: `versions/4.0.7.md`
- Modify: `src/renderer/src/versions.json`

- [ ] **Step 1: 先确认目标版本尚未存在**

Run:

```bash
if rg -n '4\.0\.7' package.json no.mifi.losslesscut.appdata.xml versions src/renderer/src/versions.json
then
  echo '4.0.7 already exists; inspect before continuing'
  exit 1
else
  echo '4.0.7 is available'
fi
```

Expected: 打印 `4.0.7 is available` 并 exit 0。若已有结果，命令 exit 1，先检查是否是本任务生成的未提交改动；不得重复运行非幂等 version hook。

- [ ] **Step 2: 手工把 package version 改为 4.0.7**

只把 `package.json` 顶层 `"version": "4.0.6"` 改成 `"version": "4.0.7"`。不运行 `npm version` 或 `yarn version`，避免自动 tag 或额外 staging。

- [ ] **Step 3: 创建简短发布说明**

`versions/4.0.7.md` 内容固定为：

```md
- Add a configurable fade-through-black transition at merged cut points
- Keep merged duration and audio timing exact while re-encoding only required video boundary regions
```

- [ ] **Step 4: 只运行一次 version hook 并生成应用内版本 JSON**

Run:

```bash
NODE_OPTIONS=--experimental-strip-types node script/postversion.ts
NODE_OPTIONS=--experimental-strip-types node script/generateVersions.ts
```

Expected: appdata 顶部新增唯一 `<release version="4.0.7" date="2026-07-22"/>`，`versions.json` 含唯一 4.0.7 记录和两条 highlights。

- [ ] **Step 5: 验证版本一致性并提交**

Run:

```bash
rg -n '4\.0\.7' package.json no.mifi.losslesscut.appdata.xml versions/4.0.7.md src/renderer/src/versions.json
git diff --check
```

Expected: 四个版本位置一致，appdata 和 versions JSON 没有重复 4.0.7。

```bash
git add package.json no.mifi.losslesscut.appdata.xml versions/4.0.7.md src/renderer/src/versions.json
git commit -m "chore: bump version to 4.0.7"
```

---

### Task 8: 全量验证、人工界面验收和 arm64 交付包

**Files:**

- Verify only: all task files
- Generated artifact: `dist/LosslessCut-mac-arm64.dmg`

- [ ] **Step 1: 确认提交范围和参考文件隔离**

Run:

```bash
git status --short
git diff --stat origin/master...HEAD
git ls-files '参考/*'
```

Expected: `参考/` 仍是未跟踪用户目录，`git ls-files` 无输出；没有任务外文件被纳入提交。

- [ ] **Step 2: 运行完整验证阶梯**

Run in this order:

```bash
yarn test run
yarn tsc
yarn lint
yarn test-exact-export
NODE_OPTIONS=--experimental-strip-types yarn build
git diff --check
```

Expected: 每条命令 exit 0；真实导出回归报告 5.7 秒、342 帧、末帧到黑、音频包一致和复制包保留率达标。

- [ ] **Step 3: 启动应用做截图位置人工验收**

Run:

```bash
yarn dev
```

等待 Electron 窗口出现，打开一个视频，确认：控件位于撤销/重做/分割之后和波形/缩略图之前；默认勾选显示 `0.46 s`；取消时只隐藏输入与单位；重新勾选恢复数值；切换 Export mode 不影响组件显示；窄窗口不覆盖中央时间控件。记录人工验收结果，在启动该命令的 PTY 中发送 Ctrl-C 并确认开发进程退出。

- [ ] **Step 4: 构建规定的 macOS arm64 DMG**

仅在前面全部通过后运行：

```bash
/Users/helchan/.codex/skills/losslesscut-build-package/scripts/build_macos_dmg.sh --arch arm64
```

Expected: 新生成 `dist/LosslessCut-mac-arm64.dmg`，脚本完成 arm64 构建和镜像校验；不构建 x64。

- [ ] **Step 5: 独立核对交付物**

Run:

```bash
stat -f '%N %z bytes %Sm' dist/LosslessCut-mac-arm64.dmg
hdiutil verify dist/LosslessCut-mac-arm64.dmg
shasum -a 256 dist/LosslessCut-mac-arm64.dmg
```

Expected: 三条命令 exit 0，`hdiutil verify` 成功；记录准确 SHA-256。

然后分别运行并记录退出码：

```bash
codesign -dv --verbose=4 dist/mac-arm64/LosslessCut.app
```

```bash
xcrun stapler validate dist/LosslessCut-mac-arm64.dmg
```

Expected: `codesign`/`stapler` 允许按本地 unsigned/not-notarized 交付预期返回非零；无论退出码如何都保留原始输出，用于明确报告本地包是否仅 ad-hoc/未签名以及未公证状态，不把预期失败伪装成打包失败，也不因 stapler 非零跳过最终审计。

- [ ] **Step 6: 最终工作树和提交审计**

Run:

```bash
git status --short --branch
git log --oneline origin/master..HEAD
```

Expected: 除用户的 `参考/` 和本次构建产物外无遗漏源码改动；设计、实现、测试、文档和版本提交顺序清晰。最终答复报告验证命令、人工 UI 结果、DMG 绝对路径、`hdiutil verify`、SHA-256、签名/公证状态，以及任何未完成边界。
