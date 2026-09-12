"""Restricted expression evaluator, not a general Python execution endpoint."""
import ast
import base64
import io
import json
import math
import os
import resource
import sys

os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
os.environ.setdefault('MPLCONFIGDIR','/tmp/math-bot-matplotlib')

resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024**2, 4 * 1024**2))
import sympy as s

FUNCTIONS = {name: getattr(s, name) for name in ('sin','cos','tan','asin','acos','atan','sqrt','log','exp','Abs')}
NAMES = {'x':s.Symbol('x', real=True), 'pi':s.pi, 'e':s.E}

def expression(text):
    if not isinstance(text,str) or len(text)>500:
        raise ValueError('Expression must be at most 500 characters.')
    tree=ast.parse(text.replace('^','**'),mode='eval')
    if len(list(ast.walk(tree)))>100:
        raise ValueError('Expression is too complex.')
    def visit(node):
        if isinstance(node,ast.Expression): return visit(node.body)
        if isinstance(node,ast.Constant) and type(node.value) in (int,float):
            if not math.isfinite(node.value) or abs(node.value)>1e12: raise ValueError('Number exceeds limit.')
            return s.Rational(str(node.value))
        if isinstance(node,ast.Name) and node.id in NAMES: return NAMES[node.id]
        if isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)):
            return visit(node.operand) * (-1 if isinstance(node.op,ast.USub) else 1)
        if isinstance(node,ast.BinOp):
            left,right=visit(node.left),visit(node.right)
            if isinstance(node.op,ast.Add): return left+right
            if isinstance(node.op,ast.Sub): return left-right
            if isinstance(node.op,ast.Mult): return left*right
            if isinstance(node.op,ast.Div): return left/right
            if isinstance(node.op,ast.Pow):
                if not right.is_number or abs(float(right))>100: raise ValueError('Exponent must be numeric and between -100 and 100.')
                if left.is_number and left not in (0,1,-1) and abs(float(s.log(s.Abs(left))*right))>10000: raise ValueError('Result exceeds limit.')
                return left**right
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in FUNCTIONS and len(node.args)==1 and not node.keywords:
            return FUNCTIONS[node.func.id](visit(node.args[0]))
        raise ValueError('Use numbers, x, pi, e, arithmetic, or supported one-argument math functions.')
    return visit(tree)

def main(data):
    expr=expression(data['expression'])
    operation=data.get('operation','simplify')
    if operation=='plot':
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        lo,hi=float(data.get('min',-10)),float(data.get('max',10))
        if not -10000<=lo<hi<=10000: raise ValueError('Plot bounds must increase and be within -10000 to 10000.')
        xs=[lo+(hi-lo)*i/300 for i in range(301)]
        ys=[]
        for x in xs:
            try:
                y=float(expr.subs(NAMES['x'],x).evalf())
                ys.append(y if math.isfinite(y) and abs(y)<1e10 else float('nan'))
            except (TypeError,ValueError,OverflowError): ys.append(float('nan'))
        fig,ax=plt.subplots(figsize=(7,4),layout='constrained')
        ax.plot(xs,ys); ax.set(xlabel='x',ylabel='y',title=str(expr)[:100]); ax.grid(True,alpha=.3)
        buf=io.BytesIO();fig.savefig(buf,format='png',dpi=120);plt.close(fig)
        return {'answer':f'Plot of {expr} from {lo} to {hi}. Discontinuities and narrow features may be missed by sampling.', 'artifact':base64.b64encode(buf.getvalue()).decode()}
    if operation=='differentiate': result=s.diff(expr,NAMES['x'])
    elif operation=='integrate': result=s.integrate(expr,NAMES['x'])
    elif operation=='solve': result=s.solve(expr,NAMES['x'])
    elif operation=='simplify': result=s.simplify(expr)
    else: raise ValueError('Unknown operation.')
    return {'answer':str(result)[:12000]}

if __name__=='__main__':
    try: print(json.dumps(main(json.loads(sys.stdin.read(16000)))))
    except Exception: print(json.dumps({'error':'Could not evaluate that expression. Check syntax and complexity.'}))
