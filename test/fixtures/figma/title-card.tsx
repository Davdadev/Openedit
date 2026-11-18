// Hand-written fixture mimicking Figma MCP get_design_context output (React + Tailwind + inline SVG).
// Frame "Title / Episode" 1920x1080 on a transparent background.
export default function TitleEpisode() {
  return (
    <div className="relative w-[1920px] h-[1080px] flex flex-col items-center justify-center gap-[28px]" data-name="Title / Episode" data-node-id="20:1">
      <p className="font-['Avenir_Next:Demi_Bold',_sans-serif] text-[26px] tracking-[0.42em] uppercase text-[var(--brand-accent,#ffb547)] leading-[normal]" data-name="#kicker" data-node-id="20:2">
        {"Episode 04"}
      </p>
      <p className="font-['Didot:Bold',_'Georgia',_serif] text-[148px] leading-[0.98] tracking-[-0.01em] text-[#f6f3ee] text-center whitespace-nowrap" data-name="#title" data-node-id="20:3">
        {"The Quiet Edit"}
      </p>
      <svg className="block w-[560px] h-[24px]" viewBox="0 0 560 24" fill="none" data-name="rule" data-node-id="20:4">
        <path d="M2 12 H250" stroke="#f6f3ee" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
        <circle cx="280" cy="12" r="5" fill="var(--brand-accent,#ffb547)" />
        <path d="M310 12 H558" stroke="#f6f3ee" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="font-['Avenir_Next:Medium',_sans-serif] text-[34px] leading-[1.3] text-[rgba(246,243,238,0.78)] text-center" data-name="#subtitle" data-node-id="20:5">
        {"Cutting a documentary without losing the silence"}
      </p>
    </div>
  );
}
