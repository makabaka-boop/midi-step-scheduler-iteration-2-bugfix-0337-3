<script lang="ts">
  import { onMount } from 'svelte';
  import { SequencerController, selectedStep } from './lib/controller';
  import Transport from './lib/components/Transport.svelte';
  import TrackGrid from './lib/components/TrackGrid.svelte';
  import StepEditor from './lib/components/StepEditor.svelte';
  import RecordingPanel from './lib/components/RecordingPanel.svelte';

  const controller = new SequencerController();
  const { pattern, midiStatus, notice, selection } = controller;
  const selStep = selectedStep(pattern, selection);

  onMount(() => {
    void controller.init();
  });

  const statusText: Record<string, string> = {
    unknown: '正在检测 MIDI…',
    unsupported: 'Web MIDI 不可用（仅可编辑）',
    requesting: '正在请求 MIDI 授权…',
    denied: 'MIDI 授权被拒绝（仅可编辑）',
    ready: 'MIDI 就绪',
    error: 'MIDI 初始化失败（仅可编辑）'
  };
</script>

<main>
  <h1>MIDI 步进音序器</h1>

  {#if $notice}
    <div class="notice" role="status">{$notice}</div>
  {/if}

  <div class="panel">
    <div class="row">
      <span>
        MIDI 状态：
        <span class:status-ok={$midiStatus === 'ready'} class:status-bad={$midiStatus !== 'ready'}>
          {statusText[$midiStatus] ?? $midiStatus}
        </span>
      </span>
    </div>
  </div>

  <Transport {controller} />
  <RecordingPanel {controller} />
  <TrackGrid {controller} />

  {#if $selStep}
    <StepEditor
      step={$selStep.step}
      onChange={(patch) => controller.updateStep($selStep.trackId, $selStep.index, patch)}
    />
  {/if}
</main>
