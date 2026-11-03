import type { ReactNode } from 'react';

export function InfoPage({
  title,
  intro,
  sections = [],
  children,
}: {
  title: string;
  intro: string;
  sections?: readonly { heading: string; body: string }[];
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-4 text-lg leading-relaxed text-muted">{intro}</p>
      <div className="mt-10 space-y-8">
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 className="text-lg font-semibold">{s.heading}</h2>
            <p className="mt-2 leading-relaxed text-muted">{s.body}</p>
          </section>
        ))}
      </div>
      {children}
    </div>
  );
}
