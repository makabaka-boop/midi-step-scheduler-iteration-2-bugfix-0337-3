<script lang="ts">
  import type { SequencerController } from '../controller';
  import { MAX_BPM, MIN_BPM } from '../controller';

  let { controller }: { controller: SequencerController } = $props();

  // The controller instance never changes for the app lifetime.
  // svelte-ignore state_referenced_locally
  const { transport, tempo, outputs, inputs, selectedOutputId, selectedInputId, midiStatus } =
    controller;

  const canPlay = $derived($selectedOutputId !== null && $midiStatus === 'ready');
</script>

<div class="panel">
  <div class="row">
    {#if $transport === 'playing'}
      <button class="primary" data-testid="pause" onclick={() => controller.pause()}>暂停</button>
    {:else}
      <button class="primary" data-testid="play" disabled={!canPlay} onclick={() => controller.play()}>
        {$transport === 'paused' ? '继续' : '播放'}
      </button>
    {/if}
    <button data-testid="stop" disabled={$transport === 'stopped'} onclick={() => controller.stop()}>
      停止
    </button>

    <label>
      速度 BPM
      <input
        data-testid="tempo"
        type="number"
        min={MIN_BPM}
        max={MAX_BPM}
        value={$tempo}
        onchange={(e) => controller.setTempo(Number(e.currentTarget.value))}
      />
    </label>

    <label>
      输出设备
      <select
        data-testid="output-select"
        value={$selectedOutputId ?? ''}
        disabled={$outputs.length === 0}
        onchange={(e) => controller.selectOutput(e.currentTarget.value || null)}
      >
        <option value="">（无输出）</option>
        {#each $outputs as output (output.id)}
          <option value={output.id} disabled={!output.connected}>
            {output.name}{output.connected ? '' : '（已断开）'}
          </option>
        {/each}
      </select>
    </label>

    <label>
      输入设备（MIDI 键盘）
      <select
        data-testid="input-select"
        value={$selectedInputId ?? ''}
        disabled={$inputs.length === 0}
        onchange={(e) => controller.selectInput(e.currentTarget.value || null)}
      >
        <option value="">（无输入）</option>
        {#each $inputs as input (input.id)}
          <option value={input.id} disabled={!input.connected}>
            {input.name}{input.connected ? '' : '（已断开）'}
          </option>
        {/each}
      </select>
    </label>

    <span>状态：{$transport === 'playing' ? '播放中' : $transport === 'paused' ? '已暂停' : '已停止'}</span>
  </div>
</div>
