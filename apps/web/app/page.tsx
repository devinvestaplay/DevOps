import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <div className="shell">
        <p className="eyebrow">Platform foundation</p>
        <h1>Investaplay DevOps</h1>
        <p className="intro">
          A home for managing independent projects and their environments.
        </p>
        <p className="note">Register projects and define their environments to get started.</p>
        <Link className="button" href="/projects">Open projects</Link>
      </div>
    </main>
  );
}
