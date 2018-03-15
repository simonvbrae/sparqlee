import * as Promise from 'bluebird';
import { List, Map } from 'immutable';
import * as _ from 'lodash';
import * as RDFDM from 'rdf-data-model';
import * as RDF from 'rdf-js';
import { Algebra } from 'sparqlalgebrajs';

import { Bindings } from '../core/Bindings';
import * as C from '../util/Consts';
import { InvalidArgumentTypes, InvalidArity, UnimplementedError } from '../util/Errors';

export enum expressionTypes {
  AGGREGATE = 'aggregate',
  EXISTENCE = 'existence',
  NAMED = 'named',
  OPERATOR = 'operator',
  TERM = 'term',
  VARIABLE = 'variable',
}

export interface IExpression {
  expressionType: 'aggregate' | 'existence' | 'named' | 'operator' | 'term' | 'variable';
}

export interface IAggregateExpression extends IExpression {
  expressionType: 'aggregate';
  aggregator: string;
  distinct: boolean;
  separator?: string; // used by GROUP_CONCAT
  expression: IExpression;
}

export interface IExistenceExpression extends IExpression {
  expressionType: 'existence';
  not: boolean;
  input: Algebra.Operation;
}

export interface INamedExpression extends IExpression {
  expressionType: 'named';
  name: RDF.NamedNode;
  args: IExpression[];
}

export interface IOperatorExpression extends IExpression {
  expressionType: 'operator';
  operator: string;
  args: IExpression[];
  operatorClass: 'simple' | 'overloaded' | 'special';
  // apply(args: Expression[], mapping: Bindings): TermExpression;
}

export interface ITermExpression extends IExpression {
  expressionType: 'term';
  termType: 'literal' | 'variable';
  coerceEBV(): boolean;
  toRDF(): RDF.Term;
}

export interface IVariableExpression extends IExpression {
  expressionType: 'variable';
  name: string;
}

// ----------------------------------------------------------------------------
// Variable
// ----------------------------------------------------------------------------

export class Variable implements IVariableExpression {
  public expressionType: 'variable' = 'variable';
  public name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// ----------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------
// TODO: Not all functions are operators, and a distinction should be made.
// All operators are functions though.
//
// https://math.stackexchange.com/questions/168378/what-is-an-operator-in-mathematics
// ----------------------------------------------------------------------------

// Simple Operators -----------------------------------------------------------

// Function and operator arguments are 'flattened' in the SPARQL spec.
// If the argument is a literal, the datatype often also matters.
export type ArgumentType = 'namedNode' | C.DataTypeCategory;

export class SimpleOperator implements IOperatorExpression {
  public expressionType: 'operator' = 'operator';
  public operatorClass: 'simple' = 'simple';

  // TODO: We could check arity beforehand
  constructor(
    public operator: string,
    public arity: number,
    public args: IExpression[],
    public types: ArgumentType[],
    protected _apply: (args: ITermExpression[]) => ITermExpression,
  ) {
    if (args.length !== this.arity) {
      throw new InvalidArity(args, this.operator);
    }
  }

  public apply(args: ITermExpression[]): ITermExpression {
    if (!this._isValidTypes(args)) {
      throw new InvalidArgumentTypes(args, this.operator);
    }
    return this._apply(args);
  }

  // TODO: Test
  private _isValidTypes(args: ITermExpression[]): boolean {
    const argTypes = args.map((a: any) => a.category || a.termType);
    return _.isEqual(this.types, argTypes);
  }

  // protected abstract _apply(args: TermExpression[]): TermExpression;
}

// Overloaded Operators -------------------------------------------------------

/*
 * Varying kinds of operators take arguments of different types on which the
 * specific behaviour is dependant. Although their behaviour is often varying,
 * it is always relatively simple, and better suited for synced behaviour.
 * The types of their arguments are always terms, but might differ in
 * their term-type (eg: iri, literal),
 * their specific literal type (eg: string, integer),
 * their arity (see BNODE),
 * or even their specific numeric type (eg: integer, float).
 *
 * Examples include:
 *  - Arithmetic operations such as: *, -, /, +
 *  - Bool operators such as: =, !=, <=, <, ...
 *  - Functions such as: str, IRI
 *
 * Note: functions that have multiple arities do not belong in this category.
 * Eg: BNODE.
 *
 * See also: https://www.w3.org/TR/sparql11-query/#func-rdfTerms
 * and https://www.w3.org/TR/sparql11-query/#OperatorMapping
 */

// Maps argument types on their specific implementation.
// TODO: Make immutable.js thing.
export type OverloadMap = Map<List<ArgumentType>, SimpleEvaluator>;
export type SimpleEvaluator = (args: ITermExpression[]) => ITermExpression;
// export type OverloadMap = [
//   ArgumentType[],
//   (args: ITermExpression[]) => ITermExpression
// ][];

export class OverloadedOperator implements IOperatorExpression {
  public expressionType: 'operator' = 'operator';
  public operatorClass: 'overloaded' = 'overloaded';
  // TODO: Remove comments
  // We use strings as indexes here cause JS doesn't support arrays or objects
  // as keys (checks by reference), and tuples aren't a thing.
  private _overloadMap: OverloadMap;

  constructor(
    public operator: string,
    public arity: number,
    public args: IExpression[],
    public overloadMap: OverloadMap,
  ) {
    if (args.length !== this.arity) {
      throw new InvalidArity(args, this.operator);
    }
  }

  public apply(args: ITermExpression[]): ITermExpression {
    const func = this._monomorph(args);
    if (!func) {
      throw new InvalidArgumentTypes(args, this.operator);
    }
    return func(args);
  }

  private _monomorph(args: ITermExpression[]): SimpleEvaluator {
    const argTypes = List(args.map((a: any) => a.category || a.termType));
    return this._overloadMap.get(argTypes);
  }
}

// Special Operators ----------------------------------------------------------
/*
 * Special operators are those that don't really fit in sensible categories and
 * have extremely heterogeneous signatures that make them impossible to abstract
 * over. They are small in number, and their behaviour is often complex and open
 * for multiple correct implementations with different trade-offs.
 *
 * Due to their varying nature, they need all available information present
 * during evaluation. This reflects in the signature of the apply() method.
 *
 * They need access to an evaluator to be able to even implement their logic.
 * Especially relevant for IF, and the logical connectives.
 *
 * They can have both sync and async implementations, and both would make sense
 * in some contexts.
 */

export type SpecialOperators = 'bound' | '||' | '&&';

export abstract class SpecialOperatorAsync implements IOperatorExpression {
  public expressionType: 'operator' = 'operator';
  public operatorClass: 'special' = 'special';

  constructor(public operator: SpecialOperators, public args: IExpression[]) { }

  public abstract apply(
    args: IExpression[],
    mapping: Bindings,
    evaluate: (e: IExpression, mapping: Bindings) => Promise<ITermExpression>,
  ): Promise<ITermExpression>;

}

// ----------------------------------------------------------------------------
// Terms
// ----------------------------------------------------------------------------

export abstract class Term implements ITermExpression {
  public expressionType: 'term' = 'term';
  public abstract termType: 'variable' | 'literal';

  public coerceEBV(): boolean {
    throw new TypeError("Cannot coerce this term to EBV.");
  }

  public abstract toRDF(): RDF.Term;
}

export interface ILiteralTerm extends ITermExpression {
  category: C.DataTypeCategory;
}

export class Literal<T> extends Term implements ILiteralTerm {
  public expressionType: 'term' = 'term';
  public termType: 'literal' = 'literal';
  public category: C.DataTypeCategory;

  constructor(
    public typedValue: T,
    public strValue?: string,
    public dataType?: RDF.NamedNode,
    public language?: string) {
    super();
    this.category = C.categorize(dataType.value);
  }

  public toRDF(): RDF.Term {
    return RDFDM.literal(
      this.strValue || this.typedValue.toString(),
      this.language || this.dataType);
  }
}

export class NumericLiteral extends Literal<number> {
  public category: C.NumericTypeCategory;
  public coerceEBV(): boolean {
    return !!this.typedValue;
  }
}

export class BooleanLiteral extends Literal<boolean> {
  public coerceEBV(): boolean {
    return !!this.typedValue;
  }
}

export class DateTimeLiteral extends Literal<Date> { }

export class PlainLiteral extends Literal<string> {
  public coerceEBV(): boolean {
    return this.strValue.length !== 0;
  }
}

export class StringLiteral extends Literal<string> {
  public coerceEBV(): boolean {
    return this.strValue.length !== 0;
  }
}

/*
 * This class is used when a literal is parsed, and it's value is
 * an invalid lexical form for it's datatype. The spec defines value with
 * invalid lexical form are still valid terms, and as such we can not error
 * immediately. This class makes sure that the typedValue will remain undefined,
 * and the category untyped. This way, only when operators apply to the
 * 'untyped' category, they will keep working, otherwise they will throw a 
 * type error.
 * This seems to match the spec.
 *
 * See:
 *  - https://www.w3.org/TR/xquery/#dt-type-error
 *  - https://www.w3.org/TR/rdf-concepts/#section-Literal-Value
 *  - https://www.w3.org/TR/xquery/#dt-ebv
 *  - ... some other more precise thing i can't find...
 */
export class NonLexicalLiteral extends Literal<undefined> {
  constructor(
    typedValue: any,
    strValue?: string,
    dataType?: RDF.NamedNode,
    language?: string) {
    super(typedValue, strValue, dataType, language);
    this.typedValue = undefined;
    this.category = 'untyped';
  }
}
