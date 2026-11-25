// oxlint exports no plugin types yet (JS plugins are alpha), so the context is typed by hand.
type Loc = { start: { line: number; column: number }; end: { line: number; column: number } }
type Context = {
  sourceCode: {
    getDisableDirectives(): { directives: { node: { loc: Loc }; justification: string }[] }
  }
  report(problem: { message: string; loc: Loc }): void
}

export default {
  meta: { name: 'directives' },
  rules: {
    'require-reason': {
      create(context: Context) {
        for (const { node, justification } of context.sourceCode.getDisableDirectives()
          .directives) {
          // Reported at the comment, or the error lands on line 1.
          if (!justification.trim())
            context.report({ message: 'Give the disable a reason: `-- why`', loc: node.loc })
        }
        return {}
      },
    },
  },
}
