<script lang="ts">
  import type { SequencerController } from '../controller';
  import { MAX_STEPS, MAX_TRACKS, MIN_STEPS, MIN_TRACKS } from '../sequencer/types';

  let { controller }: { controller: SequencerController } = $props();

  // The controller instance never changes for the app lifetime.
  // svelte-ignore state_referenced_locally
  const { pattern, currentStep, selection, transport, recording } = controller;

  function isPlayhead(trackLength: number, index: number): boolean {
    return (
      $transport !== 'stopped' && $currentStep >= 0 && $currentStep % trackLength === index
    );
  }

  /** The live draft entry for (trackId, cell), or null. */
  function draftOf(trackId: string, cell: number) {
    const r = $recording;
    if (!r.armed || r.trackId !== trackId) return null;
    return r.cells.find((c) => c.cell === cell) ?? null;
  }

  function canArm(trackId: string): boolean {
    const r = $recording;
    return (
      $transport === 'playing' &&
      (!r.armed || r.trackId === trackId)
    );
  }
</script>

<div class="panel">
  <div class="row" style="margin-bottom: 10px;">
    <strong>乐谱</strong>
    <button
      data-testid="add-track"
      disabled={$pattern.tracks.length >= MAX_TRACKS}
      onclick={() => controller.addTrack()}
    >
      + 添加音轨
    </button>
  </div>

  {#each $pattern.tracks as track, ti (track.id)}
    <div class="track" data-testid="track-{ti}">
      <div class="track-head">
        <span class="track-name">{track.name}</span>
        <label>
          通道
          <input
            type="number"
            min="1"
            max="16"
            value={track.channel + 1}
            data-testid="channel-{ti}"
            onchange={(e) => controller.setTrackChannel(track.id, Number(e.currentTarget.value) - 1)}
          />
        </label>
        <label>
          步数
          <input
            type="number"
            min={MIN_STEPS}
            max={MAX_STEPS}
            value={track.steps.length}
            data-testid="length-{ti}"
            onchange={(e) => controller.setTrackLength(track.id, Number(e.currentTarget.value))}
          />
        </label>
        <button
          class:active={track.muted}
          data-testid="mute-{ti}"
          onclick={() => controller.toggleMute(track.id)}
        >
          {track.muted ? '已静音' : '静音'}
        </button>
        <button
          class="rec"
          class:armed={$recording.armed && $recording.trackId === track.id}
          data-testid="arm-{ti}"
          disabled={!canArm(track.id)}
          onclick={() => controller.armRecording(track.id)}
        >
          {$recording.armed && $recording.trackId === track.id ? '● 录制中' : '录制本轮'}
        </button>
        <button
          data-testid="remove-track-{ti}"
          disabled={$pattern.tracks.length <= MIN_TRACKS}
          onclick={() => controller.removeTrack(track.id)}
        >
          删除
        </button>
      </div>
      <div class="steps" style="grid-template-columns: repeat({track.steps.length}, minmax(14px, 1fr));">
        {#each track.steps as step, si (si)}
          {@const draft = draftOf(track.id, si)}
          <button
            class="step"
            class:on={step.enabled}
            class:playhead={isPlayhead(track.steps.length, si)}
            class:selected={$selection?.trackId === track.id && $selection?.index === si}
            class:rec-draft={draft !== null && !draft.open}
            class:rec-open={draft !== null && draft.open}
            data-testid="step-{ti}-{si}"
            title={draft ? `录音草稿：${draft.pitch}` : `步 ${si + 1}`}
            onclick={() => controller.toggleStep(track.id, si)}
          ></button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .track {
    margin-bottom: 10px;
  }
  .track-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
  }
  .track-name {
    min-width: 70px;
    font-weight: 600;
  }
  .track-head input[type='number'] {
    width: 64px;
  }
  button.rec.armed {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
  }
  .steps {
    display: grid;
    gap: 3px;
  }
  .step {
    height: 26px;
    padding: 0;
    border-radius: 4px;
    background: var(--panel-2);
    border: 1px solid var(--border);
  }
  .step.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .step.playhead {
    box-shadow: 0 0 0 2px var(--accent-2);
  }
  .step.selected {
    outline: 2px solid #fff;
    outline-offset: 1px;
  }
  /* Complete recorded cells are outlined in the take colour without
     changing the playing score; still-held (hanging) ones pulse. */
  .step.rec-draft {
    outline: 2px dashed var(--danger);
    outline-offset: 1px;
  }
  .step.rec-open {
    outline: 2px solid var(--danger);
    outline-offset: 1px;
    animation: rec-pulse 1s ease-in-out infinite;
  }
  @keyframes rec-pulse {
    50% {
      outline-color: transparent;
    }
  }
</style>
