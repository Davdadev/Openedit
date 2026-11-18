// Hand-written fixture mimicking Figma MCP get_design_context output (React + Tailwind).
// Frame "Lower third / Speaker" 1920x1080, layers named with OpenEdit field conventions.
const imgAccent = "http://localhost:3845/assets/3f2a9c1d.svg";

export default function LowerThirdSpeaker() {
  return (
    <div className="relative size-full w-[1920px] h-[1080px]" data-name="Lower third / Speaker" data-node-id="12:40">
      <div className="absolute left-[120px] bottom-[132px] flex flex-row items-stretch" data-name="lt" data-node-id="12:41">
        <div className="w-[10px] rounded-[3px] bg-[var(--brand-accent,#ff6a3d)] shrink-0" data-name="#color:accent" data-node-id="12:42" />
        <div className="relative flex flex-col gap-[10px] items-start pl-[34px] pr-[56px] py-[30px] bg-[rgba(12,13,17,0.86)] rounded-tr-[18px] rounded-br-[18px] shadow-[0px_24px_60px_0px_rgba(0,0,0,0.35)] overflow-clip" data-name="plate" data-node-id="12:43">
          <p className="font-['Avenir_Next:Bold',_'Helvetica_Neue',_sans-serif] text-[60px] leading-[1.02] tracking-[-0.02em] text-white whitespace-nowrap" data-name="#name" data-node-id="12:44">
            {"Maya Okafor"}
          </p>
          <div className="flex flex-row gap-[14px] items-center" data-name="meta" data-node-id="12:45">
            <div className="w-[34px] h-[3px] rounded-full bg-[var(--brand-accent,#ff6a3d)]" data-name="dash" data-node-id="12:46" />
            <p className="font-['Avenir_Next:Demi_Bold',_'Helvetica_Neue',_sans-serif] text-[24px] leading-[normal] tracking-[0.16em] uppercase text-[#b9bdc8] whitespace-nowrap" data-name="#role" data-node-id="12:47">
              {"Head of Product · Northwind"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
