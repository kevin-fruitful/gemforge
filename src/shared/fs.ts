import get from 'lodash.get'
import { execaCommandSync } from 'execa'
import { tmpNameSync } from 'tmp'
import { glob } from 'glob'
import path from 'node:path'
import { ethers } from 'ethers'
import { error, trace, warn } from './log.js'
import { Context } from './context.js'
import parser from '@solidity-parser/parser'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import type {
  ContractDefinition,
  FunctionDefinition,
  VariableDeclaration,
  TypeName,
  ElementaryTypeName,
  ArrayTypeName,
  UserDefinedTypeName,
  NumberLiteral,
} from '@solidity-parser/parser/dist/src/ast-types.d.ts'
import { Network, OnChainContract } from './chain.js'

export const $$ = async (strings: TemplateStringsArray, ...values: any[]) => {
  const cmd = String.raw({ raw: strings }, ...values)
  trace(`> ${cmd}`)
  return execaCommandSync(cmd, {
    stdio: 'inherit',
  })
}


export const ensureGeneratedFolderExists = async (folderPath: string) => {
  await $$`mkdir -p ${folderPath}`
  writeFile(`${folderPath}/.gitignore`, `*.json\n*.sol\n*.log`)
}


export const captureErrorAndExit = (err: any, msg: string) => {
  const logFilePath = tmpNameSync({
    prefix: 'gemforge-error-',
    postfix: '.log',
   }) as string

   writeFileSync(logFilePath, err.stack, {
    encoding: 'utf-8',
    flag: 'w'
  })

  error(`${msg}. A full log of the error has been written to ${logFilePath}`)
}


const _loadJson = (file: string | URL): object => {
  trace(`Loading JSON file: ${file}`)
  return JSON.parse(readFileSync(file).toString('utf-8'))
}

export const loadJson = (file: string | URL): object => {
  try {
    return _loadJson(file)
  } catch (err: any) {
    return error(`Failed to load JSON file ${file}: ${err.message}`)
  }
}

export const fileExists = (file: string) => {
  trace(`Checking if file exists: ${file}`)
  return existsSync(file)
}

export const writeTemplate = (file: string, dst: string, replacements: Record<string, string> = {}) => {
  let str = readFileSync(new URL(`../../templates/${file}`, import.meta.url), 'utf-8')
  Object.keys(replacements).forEach(key => {
    str = str.replaceAll(key, replacements[key])
  })
  trace(`Writing template to ${dst}`)
  writeFileSync(dst, str, {
    encoding: 'utf-8',
    flag: 'w'
  })
}

export const writeFile = (dst: string, content: string) => {
  trace(`Writing ${dst}`)
  writeFileSync(dst, content, {
    encoding: 'utf-8',
    flag: 'w'
  })
}

export interface DeployedAddresses {
  [chainId: string]: {
    [contractName: string]: string
  }
}

export const readDeployedAddress = (dst: string, network: Network): string | undefined =>  {
  trace(`Reading diamond proxy address for chain id ${network.chainId} from ${dst} ...`)

  const chainId = String(network.chainId)
  let obj: DeployedAddresses = {}

  try {
    obj = _loadJson(dst) as DeployedAddresses
    const addr = get(obj, ['DiamondProxy', chainId])
    if (addr) {
      return addr
    } else {
      trace(`Diamond proxy address for chain id ${chainId} does not exist in ${dst}`)
      return undefined
    }
  } catch (err: any) {
    trace(`Failed to load ${dst}: ${err.message}`)
    return undefined
  }
}

export const updateDeployedAddress = (dst: string, network: Network, address: string) => {
  trace(`Writing diamond proxy address ${address} for chain id ${network.chainId} to ${dst} ...`)

  const chainId = String(network.chainId)
  let obj: DeployedAddresses = {}

  try {
    obj = _loadJson(dst) as DeployedAddresses
    if (get(obj, ['DiamondProxy', chainId])) {
      trace(`Diamond proxy address for chain id ${chainId} exists in ${dst}. Overwriting.`)
    }
  } catch (err: any) {
    trace(`Failed to load ${dst}: ${err.message}`)
  }

  obj['DiamondProxy'] = obj['DiamondProxy'] || {}
  obj['DiamondProxy'][chainId] = address

  writeFile(dst, JSON.stringify(obj, null, 2))

  trace(`Wrote updated deployed addresses to ${dst}`)
}

export interface FacetDefinition {
  file: string,
  contractName: string,
  functions: {
    name: string,
    signature: string,
  }[],
}

export const getArtifactsFolderPath = (ctx: Context): string => {
  return path.resolve(ctx.folder, ctx.config.paths.artifacts)
}

export const getFacetsAndFunctions = (ctx: Context): FacetDefinition[] => {
  if (ctx.config.diamond.publicMethods) {
    trace('Including public methods in facet cuts')
  }

  // load facets
  const facetFiles = glob.sync(ctx.config.paths.src.facets, { cwd: ctx.folder })

  const ret: FacetDefinition[] = []
  const contractNames: Record<string, boolean> = {}
  const functionSigs: Record<string, boolean> = {}

  // get definitions
  facetFiles.forEach(file => {
    const ast = parser.parse(readFileSync(path.join(ctx.folder, file), 'utf-8'), {
      loc: true,
      tolerant: true,
    })

    const contractDefinitions = ast.children.filter(node => node.type === 'ContractDefinition') as ContractDefinition[]

    contractDefinitions.forEach(contract => {
      if (contractNames[contract.name]) {
        error(`Duplicate contract name found in ${file}: ${contract.name}`)
      } else {
        contractNames[contract.name] = true
      }

      let functionDefinitions = contract.subNodes.filter(
        node => node.type === 'FunctionDefinition'
      ) as FunctionDefinition[]

      functionDefinitions = functionDefinitions
        .filter(node => !node.isConstructor && !node.isFallback && !node.isReceiveEther)
        .filter(
          node => node.visibility === 'external' || (ctx.config.diamond.publicMethods && node.visibility === 'public')
        )

      // export declare type TypeName = ElementaryTypeName | UserDefinedTypeName | ArrayTypeName;

      const functions = functionDefinitions.map(node => {
        let signature = `function ${node.name}(${getParamString(node.parameters)}) ${node.visibility}${
          node.stateMutability ? ` ${node.stateMutability}` : ''
        }`

        if (node.returnParameters?.length) {
          signature += ` returns (${getParamString(node.returnParameters)})`
        }

        const r = {
          name: node.name!,
          signature,
        }

        if (functionSigs[r.signature]) {
          error(`Duplicate function found in ${file}: ${signature}`)
        } else {
          functionSigs[r.signature] = true
        }

        return r
      })

      ret.push({
        file,
        contractName: contract.name,
        functions,
      })
    })
  })

  return ret
}



const getParamString = (params: VariableDeclaration[]): string => {
  const p: string[] = []

  params.map(param => {
    const name = param.name ? ` ${param.name}` : ''
    const storage = param.storageLocation ? ` ${param.storageLocation}`: ''
    const typeNameString = _getTypeNameString(param.typeName!)
    p.push(`${typeNameString}${storage}${name}`)
  })

  return p.join(', ')
}


const _getTypeNameString = (typeName: TypeName): string => {
  switch (typeName.type) {
    case 'ElementaryTypeName': {
      const t = typeName as ElementaryTypeName
      return t.name
    }
    case 'UserDefinedTypeName': {
      const t = typeName as UserDefinedTypeName
      return t.namePath
    }
    case 'ArrayTypeName': {
      const t = typeName as ArrayTypeName
      const innerType = _getTypeNameString(t.baseTypeName as TypeName)
      const lenStr = t.length ? `[${(t.length as NumberLiteral).number}]` : '[]'
      return `${innerType}${lenStr}`
    }
    default: {
      return ''
    }
  }
}