import { Link } from 'react-router-dom';
import MarkdownView from '../components/MarkdownView';
import markdown from '../content/how-it-works.md?raw';

export default function HowItWorks() {
  return (
    <div className="min-h-screen bg-black text-white">
      <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
        <Link
          to="/"
          className="mb-8 inline-flex rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/20"
        >
          Back
        </Link>
        <MarkdownView markdown={markdown} />
      </main>
    </div>
  );
}
