<script lang="ts">
  import type { Step } from '../sequencer/types';
  import { noteName } from '../noteNames';

  let {
    step,
    onChange
  }: {
    step: Step;
    onChange: (patch: Partial<Omit<Step, 'enabled'>>) => void;
  } = $props();
</script>

<div class="panel" data-testid="step-editor">
  <div class="row">
    <strong>步参数</strong>
    <label>
      音高
      <input
        data-testid="pitch"
        type="number"
        min="0"
        max="127"
        value={step.pitch}
        onchange={(e) => onChange({ pitch: Number(e.currentTarget.value) })}
      />
      <span data-testid="pitch-name">{noteName(step.pitch)}</span>
    </label>
    <label>
      力度
      <input
        data-testid="velocity"
        type="range"
        min="1"
        max="127"
        value={step.velocity}
        oninput={(e) => onChange({ velocity: Number(e.currentTarget.value) })}
      />
      <span data-testid="velocity-value">{step.velocity}</span>
    </label>
    <label>
      门长
      <input
        data-testid="gate"
        type="range"
        min="5"
        max="100"
        value={Math.round(step.gate * 100)}
        oninput={(e) => onChange({ gate: Number(e.currentTarget.value) / 100 })}
      />
      <span data-testid="gate-value">{Math.round(step.gate * 100)}%</span>
    </label>
  </div>
</div>
