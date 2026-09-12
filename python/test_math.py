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
        self.assertTrue(main({'expression':'x^2','operation':'plot'})['artifact'].startswith('iVBOR'))
if __name__=='__main__': unittest.main()
