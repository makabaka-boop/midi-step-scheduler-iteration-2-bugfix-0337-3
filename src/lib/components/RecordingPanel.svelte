<script lang="ts">
  import { noteName } from '../noteNames';
  import type { SequencerController } from '../controller';
  import type { RecordVerdictKind } from '../sequencer/recorder';

  let { controller }: { controller: SequencerController } = $props();

  // svelte-ignore state_referenced_locally
  const { recording, transport } = controller;

  const verdictText: Record<RecordVerdictKind, string> = {
    retrigger: '同音高重触发：前一音符已在新触发时刻关闭',
    'cross-loop-gate': '跨循环尾部：门长已钳制为一格，不延续到下一轮',
    'gate-capped': '门长超过一格，已钳制为 100%',
    'cell-overwrite': '同一格竞争：后到的音符胜出',
    'zero-velocity-off': '零力度 note-on 已按 note-off 处理',
    'orphan-off': '无配对 note-on 的 note-off 已忽略',
    incomplete: '确认时仍在悬挂的音符不完整，已丢弃'
  };

  const kindTestId: Record<RecordVerdictKind, string> = {
    retrigger: 'retrigger',
    'cross-loop-gate': 'cross-loop',
    'gate-capped': 'gate-capped',
    'cell-overwrite': 'cell-overwrite',
    'zero-velocity-off': 'zero-velocity',
    'orphan-off': 'orphan-off',
    incomplete: 'incomplete'
  };
</script>

{#if $recording.armed}
  <div class="panel rec-panel" data-testid="recording-panel">
    <div class="row">
      <strong data-testid="recording-title">录制待确认</strong>
      <span data-testid="recording-pass">第 {$recording.pass + 1} 轮 · 通道 {$recording.channel + 1}</span>
      <span data-testid="recording-count">已捕获 {$recording.cells.filter((c) => !c.open).length} 个完整步格
        {#if $recording.cells.some((c) => c.open)}，{$recording.cells.filter((c) => c.open).length} 个悬挂{/if}</span>
      <span class="spacer"></span>
      <button
        class="primary"
        data-testid="record-confirm"
        disabled={$transport !== 'playing' && $transport !== 'paused'}
        onclick={() => controller.confirmRecording()}
      >
        确认提交
      </button>
      <button data-testid="record-cancel" onclick={() => controller.cancelRecording()}>取消丢弃</button>
    </div>

    {#if $recording.verdicts.length > 0}
      <ul class="verdicts" data-testid="recording-verdicts">
        {#each $recording.verdicts as v, i (`${v.kind}-${i}`)}
          <li data-testid={`verdict-${kindTestId[v.kind]}`}>
            {verdictText[v.kind]}（步 {v.cell >= 0 ? v.cell + 1 : '—'} · {noteName(v.pitch)}）
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .rec-panel {
    border-color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .verdicts {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
</style>
