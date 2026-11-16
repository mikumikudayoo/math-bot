import unittest
from math_worker import expression, main
class MathTests(unittest.TestCase):
    def test_arithmetic(self):
        self.assertEqual(main({'expression':'293*817'})['answer'],'239381')
    def test_symbolic(self):
        self.assertEqual(main({'expression':'x^2-4','operation':'solve'})['answer'],'[-2, 2]')
        self.assertEqual(main({'expression':'x^2','operation':'differentiate'})['answer'],'2*x')
    def test_injection(self):
        for text in ["__import__('os').system('id')",'x.__class__','[x for x in (1,2)]','lambda: 1','2**10000','2**(2**100)']:
            with self.assertRaises((ValueError,SyntaxError,TypeError)):
                expression(text)
    def test_plot(self):
        import base64
        import io
        import json
        from PIL import Image

        result = main({'expression':'x^2','operation':'plot','min':-2,'max':2})
        with Image.open(io.BytesIO(base64.b64decode(result['artifact']))) as image:
            self.assertEqual(image.format, 'PNG')
            receipt = json.loads(image.info['AlephPlot'])
            self.assertEqual(receipt, {'expression':'x^2','min':-2,'max':2,'finite':301,
                                       'samples':[[-2,4],[0,0],[2,4]]})
        with self.assertRaises(ValueError):
            main({'expression':'sqrt(-1)','operation':'plot'})
if __name__=='__main__': unittest.main()
