/**
 * Terraform / HCL, read by the scanner.
 *
 * A Terraform file's identity is its block labels, so the fixtures here are about the two
 * things that can look like a label or a brace without being one: a comment, and a heredoc
 * body (where a shell script or a JSON policy lives). The third case is the reference
 * syntax, which is the whole point — an address written in one block must match the
 * address the other block declares.
 *
 * @module plugin-codegraph/tests/hcl
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { parseHcl } from '../src/hcl.ts'

const SAMPLE = [
  'variable "region" {',
  '  default = "ap-east-1"',
  '}',
  '',
  'resource "aws_instance" "web" {',
  '  ami           = data.aws_ami.ubuntu.id',
  '  subnet_id     = var.subnet',
  '  instance_type = local.size',
  '  tags = {',
  '    Name = "web"',
  '  }',
  '}',
  '',
  'data "aws_ami" "ubuntu" {',
  '  most_recent = true',
  '}',
  '',
  'module "db" {',
  '  source = "./modules/db"',
  '}',
  '',
  'output "ip" {',
  '  value = aws_instance.web.public_ip',
  '}',
  '',
  'locals {',
  '  size = "t3.micro"',
  '}',
].join('\n')

/** The declarations a file produced, as `kind:name`. */
function declared(source: string): string[] {
  return parseHcl(source, 'infra/main.tf').symbols.map(symbol => `${symbol.kind}:${symbol.name}`)
}

describe('parseHcl — declarations', () => {
  it('reads resources, data sources, modules, variables and outputs by address', () => {
    // The ADDRESS, not the label: `aws_instance.web` is what another file writes, and one
    // spelling on both sides is what lets the graph resolve the reference by name.
    assert.deepEqual(declared(SAMPLE), [
      'variable:var.region',
      'struct:aws_instance.web',
      'struct:data.aws_ami.ubuntu',
      'module:module.db',
      'variable:output.ip',
    ])
  })

  it('declares nothing for terraform and locals blocks', () => {
    // They carry no name anyone can reference; `locals` values are addressed through
    // `local.<key>`, which is a reference, not a declaration of the block.
    assert.deepEqual(declared('terraform {\n  required_version = ">= 1.0"\n}\nlocals {\n  a = 1\n}'), [])
  })

  it('gives a block the lines its body spans', () => {
    const parsed = parseHcl(SAMPLE, 'a.tf')
    const web = parsed.symbols.find(symbol => symbol.name === 'aws_instance.web')
    assert.deepEqual([web?.line, web?.endLine], [5, 12])
  })
})

describe('parseHcl — where a block ends', () => {
  it('is not cut short by a brace in a comment', () => {
    const source = ['resource "a_one" "x" {', '  # a } in a comment', '  value = 1', '}', 'resource "a_two" "y" {', '}'].join('\n')
    assert.deepEqual(declared(source), ['struct:a_one.x', 'struct:a_two.y'])
  })

  it('is not cut short by a brace inside a heredoc', () => {
    // Shell scripts and JSON policies live in heredocs; their braces are not HCL.
    const source = [
      'resource "a_one" "x" {',
      '  policy = <<EOF',
      '  { "Version": "2012-10-17" }',
      '  EOF',
      '  after = var.somewhere',
      '}',
      'resource "a_two" "y" {',
      '}',
    ].join('\n')
    const parsed = parseHcl(source, 'a.tf')
    assert.deepEqual(parsed.symbols.map(symbol => symbol.name), ['a_one.x', 'a_two.y'])
    assert.deepEqual(parsed.calls.map(call => call.name), ['var.somewhere'], 'the body after the heredoc is still read')
  })
})

describe('parseHcl — what a block reads', () => {
  it('names the addresses a block depends on, owned by that block', () => {
    const parsed = parseHcl(SAMPLE, 'a.tf')
    const fromWeb = parsed.calls.filter(call => call.owner === 'a.tf#struct:aws_instance.web')
    // Sorted: the order references are found in is the pattern table's, which is not a
    // fact worth pinning — what matters is which addresses were found at all.
    assert.deepEqual(fromWeb.map(call => call.name).sort(), ['data.aws_ami.ubuntu', 'local.size', 'var.subnet'])
  })

  it('links an output to the resource it exposes', () => {
    const parsed = parseHcl(SAMPLE, 'a.tf')
    assert.deepEqual(parsed.calls.filter(call => call.owner === 'a.tf#variable:output.ip').map(call => call.name), ['aws_instance.web'])
  })

  it('does not read a module attribute as a resource address', () => {
    // `module.db.id` is a module output, not a provider resource: the resource pattern
    // requires an underscore in the type, which the HCL convention guarantees.
    const parsed = parseHcl('output "x" {\n  value = module.db.id\n}', 'a.tf')
    assert.deepEqual(parsed.calls.map(call => call.name), ['module.db'])
  })
})
