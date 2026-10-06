export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <div className={`${className} grid place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm`}>
      <span className="font-display text-[0.95em] font-semibold leading-none">M</span>
    </div>
  );
}
