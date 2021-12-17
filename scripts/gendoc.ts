import Pkg from '../package.json'
import fs from 'fs'
import { JSONSchema7, JSONSchema7Type } from 'json-schema'
import ts from 'typescript'
import pathLib from 'path'

const fsp = fs.promises

type Definition = JSONSchema7

type Cmd = {
  title: string
  command: string
}

type Section = {
  title?: string
  rows: Row[]
}

type Row = {
  name: string
  description: string
  type?: string
  default?: JSONSchema7Type
}

abstract class DocGenerator {
  protected ignorePrettierStart = '<!-- prettier-ignore-start -->'
  protected ignorePrettierEnd = '<!-- prettier-ignore-end -->'
  protected hint = `<!-- Generated by '${this.generateCommand}', please don't edit it directly -->`

  constructor(public generateCommand: string) {}

  abstract generate(): Promise<Section[]>

  protected printJson(obj: JSONSchema7Type, format = false) {
    return JSON.stringify(obj, undefined, format ? '  ' : undefined)
  }

  protected printAsDetails(rows: Row[]) {
    const lines: string[] = []
    rows.forEach((row) => {
      let hideLine = ''
      if (row.type) {
        hideLine += `Type: <pre><code>${row.type}</code></pre>`
      }
      if (row.default !== undefined) {
        hideLine += 'Default: '
        hideLine += '<pre><code>' + this.printJson(row.default, true) + '</code></pre>'
      }
      if (hideLine) {
        lines.push(`<details>`)
      }
      lines.push(`<summary><code>${row.name}</code>: ${row.description}.</summary>`)
      if (hideLine) {
        lines.push(hideLine)
        lines.push('</details>')
      }
    })
    return lines
  }

  /**
   * @deprecated
   */
  protected printAsList(rows: Row[]) {
    const lines: string[] = []
    rows.forEach((row) => {
      let line = `- \`${row.name}\``
      const descriptions: string[] = []
      if (row.description) {
        descriptions.push(row.description)
      }
      if (row.type) {
        descriptions.push(`type: \`${this.printJson(row.type)}\``)
      }
      if (row.default !== undefined) {
        descriptions.push(`default: \`${this.printJson(row.default)}\``)
      }
      if (descriptions.length) {
        line += ': ' + descriptions.join(', ')
      }
      lines.push(line)
    })
    return lines
  }

  async attach(headLevel: number, attachTitle: string, markdownPath: string) {
    const markdown = await fsp.readFile(markdownPath, 'utf8')
    const markdownLines = markdown.split('\n')
    let startIndex = markdownLines.findIndex((line) =>
      new RegExp('#'.repeat(headLevel) + '\\s*' + attachTitle + '\\s*').test(line),
    )
    if (startIndex < 0) {
      return
    }
    startIndex += 1
    const endIndex = markdownLines
      .slice(startIndex)
      .findIndex((line) => new RegExp(`#{1,${headLevel}}[^#]`).test(line))
    const removeCount = endIndex < 0 ? 0 : endIndex

    const sections = await this.generate()
    const lines: string[] = ['', this.hint, this.ignorePrettierStart]
    for (const section of sections) {
      if (section.title) {
        lines.push(`<strong>${section.title}</strong>`)
      }
      lines.push(...this.printAsDetails(section.rows))
    }
    lines.push('')
    lines.push(this.ignorePrettierEnd)
    lines.push('')
    markdownLines.splice(startIndex, removeCount, ...lines)
    console.log(markdownLines.join('\n'))
    await fsp.writeFile(markdownPath, markdownLines.join('\n'))
    console.log(`Attached to ${attachTitle} header`)
  }
}

class ConfigurationDocGenerator extends DocGenerator {
  constructor(generateCommand: string, public packageDeclarationFilepath: string) {
    super(generateCommand)
  }

  isNodeExported(node: ts.Node) {
    return (
      (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
      (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
    )
  }

  async generate() {
    const defRows: Row[] = []
    const propRows: Row[] = []

    const conf = Pkg.contributes.configuration
    const title = conf.title
    const filename = pathLib.basename(this.packageDeclarationFilepath)

    const Kind = ts.SyntaxKind
    const prog = ts.createProgram([this.packageDeclarationFilepath], {
      strict: true,
    })
    const sourceFile = prog.getSourceFile(this.packageDeclarationFilepath)!
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
    const checker = prog.getTypeChecker()

    function print(node: ts.Node): string {
      return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
    }

    function debug(node: ts.Node) {
      console.log(Kind[node.kind])
      console.log(print(node))
    }

    sourceFile.forEachChild((node) => {
      if (!this.isNodeExported(node)) {
        return
      }

      if (ts.isTypeAliasDeclaration(node)) {
        defRows.push({
          name: node.name.text,
          description: node.name.text,
          type: print(node.type),
        })
      } else if (ts.isInterfaceDeclaration(node)) {
        if (node.name.text === title) {
          node.forEachChild((prop) => {
            if (!ts.isPropertySignature(prop)) {
              return
            }
            const symbol = checker.getSymbolAtLocation(prop.name)
            if (!symbol) {
              return
            }

            const name = symbol.getName()
            // @ts-ignore
            const jsonProp = conf.properties[name as any] as Definition & {
              default_doc?: string
            }
            propRows.push({
              name,
              description: ts.displayPartsToString(symbol.getDocumentationComment(checker)),
              type: prop.type ? print(prop.type) : undefined,
              default: jsonProp.default_doc ? jsonProp.default_doc : jsonProp.default,
            })
          })
        }
      } else {
        console.error(`[gen_doc] ${filename} not support ${print(node)}`)
      }
    })

    return [{ title: 'Properties', rows: propRows }]
  }
}

class CommandDocGenerator extends DocGenerator {
  async generate() {
    const cmds = Pkg.contributes.commands as Cmd[]
    const rows: Row[] = []
    cmds.forEach((cmd) => {
      rows.push({
        name: cmd.command,
        description: cmd.title,
      })
    })
    return [{ rows }]
  }
}

async function main() {
  const cmd = 'yarn run bulid:doc'
  const markdownPath = `${__dirname}/../README.md`
  const packageDeclarationFilepath = `${__dirname}/../src/types/pkg-config.d.ts`
  // await new CommandDocGenerator(cmd).attach(2, 'Commands', markdownPath);
  await new ConfigurationDocGenerator(cmd, packageDeclarationFilepath).attach(
    2,
    'Configuration',
    markdownPath,
  )
}

main().catch(console.error)
